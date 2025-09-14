import type ts from "typescript";
import type * as monacoNS from "./monaco.d.ts";
import type { JSONSchema } from "./jsonSchema.d.ts";
import type { Workspace } from "./workspace.d.ts";

/** The import maps follow the spec at https://wicg.github.io/import-maps/. */
export interface ImportMap {
  imports: Record<string, string>;
  scopes: Record<string, Record<string, string>>;
}

export interface FormatOptions {
  /** Size of a tab in spaces. Default: 4. */
  tabSize?: number;
  /** Prefer spaces over tabs. Default: true.*/
  insertSpaces?: boolean;
  /** Trim trailing whitespace on a line. Default: true. */
  trimTrailingWhitespace?: boolean;
  /** Insert a newline character at the end of the file if one does not exist. Default: false. */
  insertFinalNewline?: boolean;
  /** Trim all newlines after the final newline at the end of the file. Default: false. */
  trimFinalNewlines?: boolean;
  /** Semicolon preference for JavaScript and TypeScript. Default: "insert". */
  semicolon?: "ignore" | "insert" | "remove";
}

export interface JSONSchemaSource {
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

export interface IReference {
  name: string;
  url: string;
}
export interface IData {
  name: string;
  description?: string;
  references?: IReference[];
}
export interface IAttributeData extends IData {
  valueSet?: string;
  values?: IData[];
}
export interface ITagData extends IData {
  attributes: IAttributeData[];
  void?: boolean;
}

export interface LSPModule {
  setup: (
    monaco: typeof monacoNS,
    languageId: string,
    langaugeSettings?: Record<string, unknown>,
    formattingOptions?: Record<string, unknown>,
    workspace?: Workspace,
  ) => Promise<void>;
  getWorker: () => Worker;
}

export interface LSPProvider {
  aliases?: string[];
  syntaxes?: any[];
  import: () => Promise<LSPModule>;
}

export interface LSPConfig extends LSPLanguageConfig {
  providers?: Record<string, LSPProvider>;
  formatting?: FormatOptions;
}

declare global {
  interface LSPLanguageConfig {
    html?: {
      attributeDefaultValue?: "empty" | "singlequotes" | "doublequotes";
      customTags?: ITagData[];
      hideAutoCompleteProposals?: boolean;
    };
    css?: {};
    json?: {
      /** JSON schemas for JSON language service. */
      schemas?: JSONSchemaSource[];
    };
    typescript?: {
      /** The compiler options. */
      compilerOptions?: ts.CompilerOptions;
      /** The global import maps. */
      importMap?: ImportMap;
    };
  }
}
