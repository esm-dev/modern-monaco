import type monacoNS from "./monaco.d.ts";
import type { LSPConfig } from "./lsp.d.ts";
import type { TextmateGrammarName, TextmateThemeName } from "./textmate.d.ts";
import type { ErrorNotFound, Workspace } from "./workspace.d.ts";

type Awaitable<T> = T | Promise<T>;
type MaybeGetter<T> = Awaitable<MaybeModule<T>> | (() => Awaitable<MaybeModule<T>>);
type MaybeModule<T> = T | { default: T };
type MaybeArray<T> = T | T[];
type LanguageInput = MaybeGetter<MaybeArray<TextmateGrammar>>;
type ThemeInput = MaybeGetter<TextmateTheme>;

export type TextmateGrammar = {
  name: string;
  scopeName: string;
  displayName?: string;
  foldingStartMarker?: string;
  foldingStopMarker?: string;
  injectionSelector?: string;
  injectTo?: string[];
  injections?: Record<string, any>;
  patterns: any[];
  repository?: Record<string, any>;
};

export type TextmateTheme = {
  type?: "dark" | "light";
  name: string;
  displayName?: string;
  colors?: Record<string, string>;
  tokenColors?: any[];
  semanticTokenColors?: Record<string, string>;
  semanticHighlighting?: boolean;
};

export interface ShikiInitOptions {
  /**
   * Theme names, or theme registration objects to be loaded upfront.
   */
  theme?: TextmateThemeName | (string & {}) | URL | ThemeInput;
  /**
   * Language names, or language registration objects to be loaded upfront.
   */
  langs?: (TextmateGrammarName | (string & {}) | URL | LanguageInput)[];
  /**
   * The CDN base URL to download themes and languages from. Default: "https://esm.sh".
   */
  tmDownloadCDN?: string;
}

export interface InitOptions extends ShikiInitOptions {
  /**
   * Virtual file system to be used by the editor.
   */
  workspace?: Workspace;
  /**
   * Language server protocol configuration.
   */
  lsp?: LSPConfig;
}

export function init(options?: InitOptions): Promise<typeof monacoNS>;
export function lazy(options?: InitOptions): void;
export function hydrate(options?: InitOptions): void;

export const errors: {
  NotFound: ErrorNotFound;
};

export { Workspace };
