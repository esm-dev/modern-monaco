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

export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export interface BaselineStatus {
  baseline: false | "low" | "high";
  baseline_low_date?: string;
  baseline_high_date?: string;
}

export interface IData {
  name: string;
  description?: string | MarkupContent;
  references?: IReference[];
  browsers?: string[];
  status?: BaselineStatus;
}

export interface ICSSData extends IData {
  values?: IData[];
}

export interface IAttributeData extends IData {
  valueSet?: string;
  values?: IData[];
}

export interface IValueSet {
  name: string;
  values: IData[];
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

export type SeverityLevel = "error" | "warning" | "ignore";

export interface HTMLDataV1 {
  version: 1 | 1.1;
  tags?: ITagData[];
  globalAttributes?: IAttributeData[];
  valueSets?: IValueSet[];
}

export interface CSSDataV1 {
  version: 1 | 1.1;
  properties?: (ICSSData & Record<string, unknown>)[];
  atDirectives?: (ICSSData & Record<string, unknown>)[];
  pseudoClasses?: (ICSSData & Record<string, unknown>)[];
  pseudoElements?: (ICSSData & Record<string, unknown>)[];
}

export interface DiagnosticsOptions {
  validate?: boolean;
  codesToIgnore?: (string | number)[];
  filter?: (diagnostic: monacoNS.editor.IMarkerData) => boolean;
}

declare global {
  interface LSPLanguageConfig {
    /** HTML language configuration. */
    html?: {
      /** Defines whether the standard HTML tags are shown. Default is true. */
      useDefaultDataProvider?: boolean;
      /** Provides a set of custom data providers. */
      dataProviders?: { [providerId: string]: HTMLDataV1 };
      /** Provides a set of custom HTML tags. */
      customTags?: ITagData[];
      /** The default value for empty attributes. Default is "empty". */
      attributeDefaultValue?: "empty" | "singlequotes" | "doublequotes";
      /** Whether to hide end tag suggestions. Default is false. */
      hideEndTagSuggestions?: boolean;
      /** Whether to hide auto complete proposals. Default is false. */
      hideAutoCompleteProposals?: boolean;
      /** Whether to show the import map code lens. Default is true. */
      importMapCodeLens?: boolean;
      /** Options for the diagnostics. */
      diagnosticsOptions?: DiagnosticsOptions;
    };
    /** CSS language configuration. */
    css?: {
      /** Defines whether the standard CSS properties, at-directives, pseudoClasses and pseudoElements are shown. */
      useDefaultDataProvider?: boolean;
      /** Provides a set of custom data providers. */
      dataProviders?: { [providerId: string]: CSSDataV1 };
      /** A list of valid properties that not defined in the standard CSS properties. */
      validProperties?: string[];
      /** Options for the diagnostics. */
      diagnosticsOptions?: DiagnosticsOptions;
    };
    /** JSON language configuration. */
    json?: {
      /** Whether to show the import map code lens. Default is true. */
      importMapCodeLens?: boolean;
      /** Defines whether comments are allowed or not. Default is disallowed. */
      allowComments?: boolean;
      /** A list of known schemas and/or associations of schemas to file names. */
      schemas?: JSONSchemaSource[];
      /** The severity of reported comments. Default is "error". */
      comments?: SeverityLevel;
      /** The severity of reported trailing commas. Default is "error". */
      trailingCommas?: SeverityLevel;
      /** The severity of problems from schema validation. Default is "warning". */
      schemaValidation?: SeverityLevel;
      /** The severity of problems that occurred when resolving and loading schemas. Default is "warning". */
      schemaRequest?: SeverityLevel;
      /** Options for the diagnostics. */
      diagnosticsOptions?: DiagnosticsOptions;
    };
    /** TypeScript language configuration. */
    typescript?: {
      /** The default import maps. */
      importMap?: ImportMap;
      /** The compiler options. */
      compilerOptions?: ts.CompilerOptions;
      /** Options for the diagnostics. */
      diagnosticsOptions?: DiagnosticsOptions;
    };
  }
}
