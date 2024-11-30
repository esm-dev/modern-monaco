/*! based on https://github.com/shikijs/shiki/blob/main/packages/monaco/src/index.ts */

import type monacoNs from "monaco-editor-core";
import type { ShikiInternal, ThemeRegistrationResolved } from "@shikijs/core";
import type { StateStack } from "@shikijs/core/textmate";
import { EncodedTokenMetadata, INITIAL } from "@shikijs/core/textmate";

export interface MonacoTheme extends monacoNs.editor.IStandaloneThemeData {}

export function textmateThemeToMonacoTheme(theme: ThemeRegistrationResolved): MonacoTheme {
  const rules: MonacoTheme["rules"] = [];
  for (const { scope, settings } of theme.tokenColors ?? theme.settings) {
    const scopes = Array.isArray(scope) ? scope : [scope];
    for (const s of scopes) {
      if (s && settings?.foreground) {
        rules.push({
          token: s,
          foreground: normalizeColor(theme.bg, settings.foreground),
          fontStyle: settings?.fontStyle,
        });
      }
    }
  }
  return {
    base: theme.type === "dark" ? "vs-dark" : "vs",
    colors: Object.fromEntries(Object.entries(theme.colors ?? {}).map(([key, value]) => [key, normalizeColor(theme.bg, value)])),
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
  monaco.editor.setTheme = (themeId: string) => {
    const theme = themeMap.get(themeId);
    if (!theme) {
      console.warn("Theme not found:", themeId);
      return;
    }
    const ret = highlighter.setTheme(themeId);
    colorMap.length = ret.colorMap.length;
    ret.colorMap.forEach((color, i) => {
      colorMap[i] = normalizeColor(ret.theme.bg, color);
    });
    colorToScopeMap.clear();
    theme.rules.forEach((rule) => {
      const color = rule.foreground;
      if (color && !colorToScopeMap.has(color)) {
        colorToScopeMap.set(color, rule.token);
      }
    });
    setTheme(themeId);
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
        const color = colorMap[EncodedTokenMetadata.getForeground(metadata)] ?? "";
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

function toRGBA(hex: string) {
  const start = hex.charCodeAt(0) === 35 /* '#' */ ? 1 : 0;
  const step = (hex.length - start) >= 6 ? 2 : 1;
  const rgba = [0, 1, 2, 3].map(i => {
    const j = start + i * step;
    return parseInt(hex.slice(j, j + step).repeat(3 - step), 16);
  });
  if (Number.isNaN(rgba[3])) {
    rgba[3] = 1;
  } else {
    rgba[3] /= 255;
  }
  return rgba as [r: number, g: number, b: number, a: number];
}

function toHexColor(rgb: number[]): string {
  return "#" + rgb.map(c => c.toString(16).padStart(2, "0")).join("");
}

function channelMixer(channelA: number, channelB: number, amount: number) {
  const a = channelA * (1 - amount);
  const b = channelB * amount;
  return Math.round(a + b);
}

function normalizeColor(bg: string, fg: string): string {
  const fgRgba = toRGBA(fg);
  if (fgRgba[3] === 1) {
    return toHexColor(fgRgba.slice(0, 3));
  }
  const bgRgba = toRGBA(bg);
  return toHexColor([0, 1, 2].map(i => channelMixer(bgRgba[i], fgRgba[i], fgRgba[3])));
}
