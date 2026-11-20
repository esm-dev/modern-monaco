import type * as monacoNS from "./monaco.d.ts";
import type { ShikiInitOptions, TextmateTheme } from "./index.d.ts";
import type { RenderInput, RenderOptions } from "./ssr.d.ts";

export type { RenderInput, RenderOptions, ShikiInitOptions };

export interface GrammarInfo {
  name: string;
  scopeName?: string;
  aliases?: string[];
  embedded?: string[];
  embeddedIn?: string[];
  injectTo?: string[];
}

export interface MonacoTheme extends monacoNS.editor.IStandaloneThemeData {}

export interface Highlighter {
  codeToHtml(code: string, options: Record<string, any>): string;
  codeToHast(code: string, options: Record<string, any>): any;
  codeToTokens(code: string, options: Record<string, any>): any;
  codeToTokensBase(code: string, options: Record<string, any>): any;
  codeToTokensWithThemes(code: string, options: Record<string, any>): any;
  getTheme(name: string): any;
  setTheme(name: string): { theme: any; colorMap: string[] };
  getLanguage(name: string): any;
  getLoadedThemes(): string[];
  getLoadedLanguages(): string[];
  loadTheme(...themes: any[]): Promise<void>;
  loadLanguage(...langs: any[]): Promise<void>;
  loadThemeFromCDN(name: string): Promise<void>;
  loadGrammarFromCDN(...ids: string[]): Promise<void>;
  dispose(): void;
}

export function initShiki(options?: ShikiInitOptions): Promise<Highlighter>;
export function ensureShikiResources(
  highlighter: Highlighter,
  options?: Pick<ShikiInitOptions, "defaultTheme" | "theme" | "themes" | "langs" | "cdn">,
): Promise<Highlighter>;
export function registerGrammarInfo(lang: unknown): void;
export function getGrammarInfo(nameOrAlias: string): GrammarInfo | undefined;
export function resolveLanguage(nameOrAlias: string): string | undefined;
export function normalizeThemeId(src: string): string;
export function resolveThemeId(theme: ShikiInitOptions["defaultTheme"], loadedThemes?: string[]): string | undefined;
export function getGrammarInfoFromPath(path: string): GrammarInfo | undefined;
/** @deprecated Use `getGrammarInfoFromPath` instead. */
export function getGarmmarInfoFromPath(path: string): GrammarInfo | undefined;
export function getLanguageIdFromPath(path: string): string | undefined;
export function getExtnameFromLanguageId(language: string): string | undefined;
export function render(highlighter: Highlighter, input: RenderInput, options?: RenderOptions): string;
export function textmateThemeToMonacoTheme(theme: any): MonacoTheme;
export function initShikiMonacoTokenizer(monaco: typeof monacoNS, highlighter: Highlighter, defaultTheme?: string): void;
export function registerShikiMonacoTokenizer(monaco: typeof monacoNS, highlighter: Highlighter, languageId: string): void;
export function setDefaultWasmLoader(loader: any): void;

export const grammars: GrammarInfo[];
export const themes: Map<string, TextmateTheme>;
