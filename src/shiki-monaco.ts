/*! based on https://github.com/shikijs/shiki/blob/main/packages/monaco/src/index.ts */

import type monacoNs from "monaco-editor-core";
import type { ShikiPrimitive, ThemeRegistrationResolved } from "@shikijs/core";
import type { StateStack } from "@shikijs/core/textmate";
import { EncodedTokenMetadata, INITIAL } from "@shikijs/core/textmate";

export interface MonacoTheme extends monacoNs.editor.IStandaloneThemeData {}

export function textmateThemeToMonacoTheme(theme: ThemeRegistrationResolved): MonacoTheme {
  const rules: MonacoTheme["rules"] = [];
  for (const { scope, settings } of theme.tokenColors ?? theme.settings) {
    const scopes = Array.isArray(scope) ? scope : [scope];
    for (const s of scopes) {
      if (s && (settings?.foreground || settings?.fontStyle)) {
        rules.push({
          token: s,
          ...(settings.foreground ? { foreground: normalizeColor(settings.foreground) } : {}),
          fontStyle: settings.fontStyle,
        });
      }
    }
  }
  return {
    base: theme.type === "dark" ? "vs-dark" : "vs",
    colors: Object.fromEntries(Object.entries(theme.colors ?? {}).map(([key, value]) => [key, normalizeColor(value)])),
    inherit: false,
    rules,
  };
}

// Do not attempt to tokenize if a line is too long
// default to 20000 (as in monaco-editor-core defaults)
const tokenizeMaxLineLength = 20000;
const tokenizeTimeLimit = 500;

interface MonacoTokenizerState {
  originalSetTheme: typeof monacoNs.editor.setTheme;
  highlighter: ShikiPrimitive<any, any>;
  themeMap: Map<string, MonacoTheme>;
  currentThemeId: string | undefined;
  colorMap: string[];
  colorToScopeMap: Map<string, string>;
  styleToScopeMap: Map<string, string>;
}

const monacoStateMap = new WeakMap<typeof monacoNs, MonacoTokenizerState>();

export function initShikiMonacoTokenizer(
  monaco: typeof monacoNs,
  highlighter: ShikiPrimitive<any, any>,
  defaultTheme?: string,
) {
  let state = monacoStateMap.get(monaco);
  if (!state) {
    state = {
      originalSetTheme: monaco.editor.setTheme.bind(monaco.editor),
      highlighter,
      themeMap: new Map(),
      currentThemeId: undefined,
      colorMap: [],
      colorToScopeMap: new Map(),
      styleToScopeMap: new Map(),
    };
    monacoStateMap.set(monaco, state);

    // Because Monaco does not have an API to read the current theme,
    // we wrap setTheme once to keep Monaco and Shiki's theme state in sync.
    monaco.editor.setTheme = (themeId: string) => {
      const current = monacoStateMap.get(monaco)!;
      let theme = current.themeMap.get(themeId);
      if (!theme && current.highlighter.getLoadedThemes().includes(themeId)) {
        theme = textmateThemeToMonacoTheme(current.highlighter.getTheme(themeId));
        current.themeMap.set(themeId, theme);
        monaco.editor.defineTheme(themeId, theme);
      }
      if (!theme) {
        console.warn("Theme not found:", themeId);
        return;
      }
      current.currentThemeId = themeId;
      const ret = current.highlighter.setTheme(themeId);
      current.colorMap.length = ret.colorMap.length;
      ret.colorMap.forEach((color, i) => {
        current.colorMap[i] = normalizeColor(color);
      });
      current.colorToScopeMap.clear();
      current.styleToScopeMap.clear();
      const plainColors = new Set<string>();
      for (const rule of theme.rules) {
        const fontStyle = parseFontStyle(rule.fontStyle);
        const color = rule.foreground ?? "";
        if (color) {
          const styleKey = `${color}:${fontStyle}`;
          if (!current.styleToScopeMap.has(styleKey)) {
            current.styleToScopeMap.set(styleKey, rule.token);
          }
          if (!current.colorToScopeMap.has(color) || (fontStyle === 0 && !plainColors.has(color))) {
            current.colorToScopeMap.set(color, rule.token);
            if (fontStyle === 0) {
              plainColors.add(color);
            }
          }
        } else if (fontStyle !== 0) {
          const styleKey = `:${fontStyle}`;
          if (!current.styleToScopeMap.has(styleKey)) {
            current.styleToScopeMap.set(styleKey, rule.token);
          }
        }
      }
      current.originalSetTheme(themeId);
    };
  } else {
    state.highlighter = highlighter;
  }

  // Convert loaded themes to Monaco themes and register them
  const themeIds = highlighter.getLoadedThemes();
  for (const themeId of themeIds) {
    const tmTheme = highlighter.getTheme(themeId);
    const monacoTheme = textmateThemeToMonacoTheme(tmTheme);
    state.themeMap.set(themeId, monacoTheme);
    monaco.editor.defineTheme(themeId, monacoTheme);
  }

  const initialTheme = (defaultTheme && themeIds.includes(defaultTheme))
    ? defaultTheme
    : (state.currentThemeId && themeIds.includes(state.currentThemeId))
    ? state.currentThemeId
    : themeIds[0];
  if (initialTheme) {
    monaco.editor.setTheme(initialTheme);
  }
}

export function registerShikiMonacoTokenizer(monaco: typeof monacoNs, highlighter: ShikiPrimitive<any, any>, languageId: string) {
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

      const monacoState = monacoStateMap.get(monaco);
      // Restore Monaco's active theme in case a shared highlighter ran codeToHtml with another theme.
      if (monacoState?.currentThemeId) {
        highlighter.setTheme(monacoState.currentThemeId);
      }

      const grammar = highlighter.getLanguage(languageId);
      const result = grammar.tokenizeLine2(line, state.ruleStack, tokenizeTimeLimit);
      if (result.stoppedEarly) {
        console.warn(`Time limit reached when tokenizing line: ${line.substring(0, 100)}`);
      }

      const colorMap = monacoState?.colorMap ?? [];
      const colorToScopeMap = monacoState?.colorToScopeMap;
      const styleToScopeMap = monacoState?.styleToScopeMap;
      const tokensLength = result.tokens.length / 2;
      const tokens: any[] = new Array(tokensLength);
      for (let j = 0; j < tokensLength; j++) {
        const startIndex = result.tokens[2 * j];
        const metadata = result.tokens[2 * j + 1];
        const foregroundId = EncodedTokenMetadata.getForeground(metadata);
        const color = colorMap[foregroundId] ?? "";
        const fontStyle = EncodedTokenMetadata.getFontStyle(metadata);
        // Because Monaco only supports one scope per token,
        // we trace back a matching scope by color and fontStyle.
        // Only prefer font-style-only rules over color-only rules on default foreground.
        const scope = styleToScopeMap?.get(`${color}:${fontStyle}`)
          ?? (foregroundId <= 1 && fontStyle ? styleToScopeMap?.get(`:${fontStyle}`) : undefined)
          ?? colorToScopeMap?.get(color)
          ?? (fontStyle ? styleToScopeMap?.get(`:${fontStyle}`) : undefined)
          ?? "";
        tokens[j] = { startIndex, scopes: scope };
      }

      return { endState: new TokenizerState(result.ruleStack), tokens };
    },
  });
}

function parseFontStyle(fontStyle?: string): number {
  if (!fontStyle) return 0;
  let mask = 0;
  if (fontStyle.includes("italic")) mask |= 1;
  if (fontStyle.includes("bold")) mask |= 2;
  if (fontStyle.includes("underline")) mask |= 4;
  if (fontStyle.includes("strikethrough")) mask |= 8;
  return mask;
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
      other === this
      || (other instanceof TokenizerState && this._ruleStack.equals(other._ruleStack))
    );
  }
}

function toRGBA(hex: string) {
  const start = hex.charCodeAt(0) === /* '#' */ 35 ? 1 : 0;
  const step = (hex.length - start) >= 6 ? 2 : 1;
  const rgba = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const j = start + i * step;
    rgba[i] = parseInt(hex.slice(j, j + step).repeat(3 - step), 16);
  }
  if (Number.isNaN(rgba[3])) {
    rgba[3] = 255;
  }
  return rgba as [r: number, g: number, b: number, a: number];
}

function toHexColor(rgb: number[]): string {
  return "#" + rgb.map(c => c.toString(16).padStart(2, "0")).join("");
}

function normalizeColor(color: string | string[]): string {
  const rgba = toRGBA(Array.isArray(color) ? color[0] : color);
  if (rgba[3] === 255) {
    return toHexColor(rgba.slice(0, 3));
  }
  return toHexColor(rgba);
}
