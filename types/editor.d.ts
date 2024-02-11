import type ts from "typescript";
import type monacoNS from "./monaco";
import type { FormatOptions } from "./format";
import type { JSONSchema } from "./jsonSchema";
import type { TmGrammar, TmTheme } from "./tm";
import type { GrammarInfo } from "./tm-grammars";
import type { ThemeInfo } from "./tm-themes";
import type { VFS } from "./vfs";

export interface SchemaConfiguration {
  /**
   * The URI of the schema, which is also the identifier of the schema.
   */
  uri: string;
  /**
   * A list of glob patterns that describe for which file URIs the JSON schema will be used.
   * '*' and '**' wildcards are supported. Exclusion patterns start with '!'.
   * For example '*.schema.json', 'package.json', '!foo*.schema.json', 'foo/**\/BADRESP.json'.
   * A match succeeds when there is at least one pattern matching and last matching pattern does not start with '!'.
   */
  fileMatch?: string[];
  /**
   * The schema for the given URI.
   * If no schema is provided, the schema will be fetched with the schema request service (if available).
   */
  schema?: JSONSchema;
  /**
   * A parent folder for folder specifc associations. An association that has a folder URI set is only used
   * if the document that is validated has the folderUri as parent
   */
  folderUri?: string;
}

export interface ImportMap {
  imports: Record<string, string>;
  scopes: Record<string, Record<string, string>>;
}

export interface ShikiInitOptions {
  theme?: TmTheme | ThemeInfo;
  preloadGrammars?: TmGrammar[];
  customGrammars?: GrammarInfo[];
}

export interface InitOptions extends ShikiInitOptions {
  vfs?: VFS;
  format?: FormatOptions;
  json: {
    schemas?: SchemaConfiguration[];
  };
  typescript?: {
    /** The compiler options */
    compilerOptions?: ts.CompilerOptions;
    /** The global import maps */
    importMap?: ImportMap;
    /** The version of the typescript module from CDN */
    version?: string;
  };
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

export * from "./vfs";
