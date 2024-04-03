import type monacoNS from "./monaco.d.ts";
import type { LSPConfig } from "./lsp.d.ts";
import type { TextmateGrammarName, TextmateThemeName } from "./textmate.d.ts";
import type { VFS } from "./vfs.d.ts";

type Awaitable<T> = T | Promise<T>;
type MaybeGetter<T> = Awaitable<MaybeModule<T>> | (() => Awaitable<MaybeModule<T>>);
type MaybeModule<T> = T | { default: T };
type MaybeArray<T> = T | T[];
type LanguageInput = MaybeGetter<MaybeArray<NamedObject>>;
type ThemeInput = MaybeGetter<NamedObject>;

interface NamedObject {
  name: string;
}

export interface ShikiInitOptions {
  /**
   * Theme names, or theme registration objects to be loaded upfront.
   */
  theme?: TextmateThemeName | URL | ThemeInput;
  /**
   * Language names, or language registration objects to be loaded upfront.
   */
  langs?: (TextmateGrammarName | URL | LanguageInput)[];
  /**
   * The CDN base URL to download themes and languages from. Default: "https://esm.sh".
   */
  downloadCDN?: string;
}

export interface InitOptions extends ShikiInitOptions {
  /**
   * Virtual file system to be used by the editor.
   */
  vfs?: VFS;
  /**
   * Language server protocol configuration.
   */
  lsp?: LSPConfig;
}

export interface RenderOptions extends monacoNS.editor.IStandaloneEditorConstructionOptions {
  lang: string;
  code: string;
  filename?: string;
  theme?: string;
  userAgent?: string;
  fontMaxDigitWidth?: number;
}

export function init(options?: InitOptions): Promise<typeof monacoNS>;
export function lazy(options?: InitOptions): void;
export function renderToString(options: RenderOptions): Promise<string>;
export function renderToWebComponent(options: RenderOptions): Promise<string>;
