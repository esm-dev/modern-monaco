import type * as monacoNS from "./monaco.d.ts";
import type { LSPConfig } from "./lsp.d.ts";
import type { TextmateGrammarName, TextmateThemeName } from "./textmate.d.ts";
import { ErrorNotFound, FileSystem, Workspace, WorkspaceInitMultiple } from "./workspace";

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

export interface InitOptionsSingleWorkspace extends ShikiInitOptions {
  /**
     * Virtual file system to be used by the editor.
     */
  workspace?: Workspace;
  /**
    * Language server protocol configuration.
    */
  lsp?: LSPConfig;
}

export interface InitOptionsMultipleWorkspaces extends ShikiInitOptions {
  workspaces?: Workspace<WorkspaceInitMultiple>[];
  /**
  * Language server protocol configuration.
  */
  lsp?: LSPConfig;
}

export type InitOptions = InitOptionsSingleWorkspace | InitOptionsMultipleWorkspaces;


export function init(options?: InitOptions): Promise<typeof monacoNS>;
export function lazy(options?: InitOptions): Promise<void>;
export function hydrate(options?: InitOptions): Promise<void>;

export const errors: {
  NotFound: ErrorNotFound;
};

export { FileSystem, Workspace };
