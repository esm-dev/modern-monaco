import type { BundledLanguage, BundledTheme } from "./shiki";
import type { GrammarInfo } from "./tm-grammars";
import type { ThemeInfo } from "./tm-themes";
import type { VFS } from "./vfs";
import type * as monacoNS from "./monaco";

/**
 * Value-object describing what options formatting should use.
 */
export interface FormattingOptions {
  /**
   * Size of a tab in spaces.
   */
  tabSize: uinteger;
  /**
   * Prefer spaces over tabs.
   */
  insertSpaces: boolean;
  /**
   * Trim trailing whitespace on a line.
   *
   * @since 3.15.0
   */
  trimTrailingWhitespace?: boolean;
  /**
   * Insert a newline character at the end of the file if one does not exist.
   *
   * @since 3.15.0
   */
  insertFinalNewline?: boolean;
  /**
   * Trim all newlines after the final newline at the end of the file.
   *
   * @since 3.15.0
   */
  trimFinalNewlines?: boolean;
  /**
   * Signature for further properties.
   */
  [key: string]: boolean | integer | string | undefined;
}

export interface ShikiInitOptions {
  theme?: BundledTheme | ThemeInfo;
  preloadGrammars?: BundledLanguage[];
  customGrammars?: GrammarInfo[];
}

export interface InitOptions extends ShikiInitOptions {
  vfs?: VFS;
  format?: FormattingOptions;
  languages?: Record<string, Record<string, unknown>>;
}

export interface RenderOptions
  extends editor.IStandaloneEditorConstructionOptions {
  lang: string;
  code: string;
  filename?: string;
  theme?: string;
  userAgent?: string;
  fontMaxDigitWidth?: number;
}

export function init(options?: InitOptions): Promise<typeof monacoNS>;
export function lazyMode(options?: InitOptions): void;
export function renderToString(options: RenderOptions): Promise<string>;

export * from "./vfs";
