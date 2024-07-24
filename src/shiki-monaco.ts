/*! based on https://github.com/shikijs/shiki/blob/main/packages/monaco/src/index.ts */

import type monacoNs from "monaco-editor-core";
import type { ShikiInternal, ThemeRegistrationResolved } from "@shikijs/core";
import type { StateStack } from "@shikijs/core/textmate";
import { INITIAL, StackElementMetadata } from "@shikijs/core/textmate";

export interface MonacoTheme extends monacoNs.editor.IStandaloneThemeData {}

export function textmateThemeToMonacoTheme(theme: ThemeRegistrationResolved): MonacoTheme {
  let rules = "rules" in theme ? theme.rules as MonacoTheme["rules"] : undefined;

  if (!rules) {
    rules = [];
    const themeSettings = theme.settings || theme.tokenColors;
    if (Array.isArray(themeSettings)) {
      for (const { scope, settings } of themeSettings) {
        const scopes = Array.isArray(scope) ? scope : [scope];
        for (const s of scopes) {
          if (typeof s === "string" && s !== "") {
            rules.push({
              token: s,
              foreground: normalizeColor(settings?.foreground),
            });
          }
        }
      }
    }
  }

  return {
    base: theme.type === "dark" ? "vs-dark" : "vs",
    colors: Object.fromEntries(Object.entries(theme.colors ?? {}).map(([key, value]) => [key, `#${normalizeColor(value)}`])),
    inherit: false,
    rules,
  };
}

// Do not attempt to tokenize if a line is too long
// default to 20000 (as in monaco-editor-core defaults)
const tokenizeMaxLineLength = 20000;
const tokenizeTimeLimit = 500;
const colorMap: string[] = [];
const colorToScopeMap = new Map<string, string>();

export function initShikiMonacoTokenizer(monaco: typeof monacoNs, highlighter: ShikiInternal<any, any>) {
  // Convert themes to Monaco themes and register them
  const themeMap = new Map<string, MonacoTheme>();
  const themeIds = highlighter.getLoadedThemes();
  for (const themeId of themeIds) {
    const tmTheme = highlighter.getTheme(themeId);
    const monacoTheme = textmateThemeToMonacoTheme(tmTheme);
    themeMap.set(themeId, monacoTheme);
    monaco.editor.defineTheme(themeId, monacoTheme);
  }

  // Because Monaco does not have the API of reading the current theme,
  // We hijack it here to keep track of the current theme.
  const setTheme = monaco.editor.setTheme.bind(monaco.editor);
  monaco.editor.setTheme = (themeName: string) => {
    const ret = highlighter.setTheme(themeName);
    const theme = themeMap.get(themeName);
    colorMap.length = ret.colorMap.length;
    ret.colorMap.forEach((color, i) => {
      colorMap[i] = normalizeColor(color);
    });
    colorToScopeMap.clear();
    theme?.rules.forEach((rule) => {
      const c = normalizeColor(rule.foreground);
      if (c) {
        colorToScopeMap.set(c, rule.token);
      }
    });
    setTheme(themeName);
  };

  // Set the first theme as the default theme
  monaco.editor.setTheme(themeIds[0]);
}

export function registerShikiMonacoTokenizer(monaco: typeof monacoNs, highlighter: ShikiInternal<any, any>, languageId: string) {
  if (!highlighter.getLoadedLanguages().includes(languageId)) {
    // Language not loaded
    return;
  }

  monaco.languages.setTokensProvider(languageId, {
    getInitialState() {
      return new TokenizerState(INITIAL);
    },
    tokenize(line, state: TokenizerState) {
      if (line.length >= tokenizeMaxLineLength) {
        return {
          endState: state,
          tokens: [{ startIndex: 0, scopes: "" }],
        };
      }

      const grammar = highlighter.getLanguage(languageId);
      const result = grammar.tokenizeLine2(line, state.ruleStack, tokenizeTimeLimit);
      if (result.stoppedEarly) {
        console.warn(`Time limit reached when tokenizing line: ${line.substring(0, 100)}`);
      }

      const tokensLength = result.tokens.length / 2;
      const tokens: any[] = new Array(tokensLength);
      for (let j = 0; j < tokensLength; j++) {
        const startIndex = result.tokens[2 * j];
        const metadata = result.tokens[2 * j + 1];
        const color = colorMap[StackElementMetadata.getForeground(metadata)] ?? "";
        // Because Monaco only support one scope per token,
        // we workaround this to use color to trace back the scope
        const scope = colorToScopeMap.get(color) ?? "";
        tokens[j] = { startIndex, scopes: scope };
      }

      return { endState: new TokenizerState(result.ruleStack), tokens };
    },
  });
}

class TokenizerState implements monacoNs.languages.IState {
  constructor(
    private _ruleStack: StateStack,
  ) {}

  public get ruleStack(): StateStack {
    return this._ruleStack;
  }

  public clone(): TokenizerState {
    return new TokenizerState(this._ruleStack);
  }

  public equals(other: monacoNs.languages.IState): boolean {
    return (
      other
      && other instanceof TokenizerState
      && other === this
      && other._ruleStack === this._ruleStack
    );
  }
}

function normalizeColor(color: undefined): undefined;
function normalizeColor(color: string): string;
function normalizeColor(color: string | undefined): string | undefined {
  if (!color) {
    return color;
  }

  color = (color.charCodeAt(0) === 35 ? color.slice(1) : color).toLowerCase();
  // #RGB => #RRGGBB - Monaco does not support hex color with 3 or 4 digits
  if (color.length === 3 || color.length === 4) {
    color = color.split("").map(c => c + c).join("");
  }

  return color;
}
