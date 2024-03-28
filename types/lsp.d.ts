import type ts from "typescript";
import type monacoNS from "./monaco.d.ts";
import type { JSONSchema } from "./jsonSchema.d.ts";
import type { VFS } from "./vfs.d.ts";

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

export interface JSONSchemaConfiguration {
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

export interface LSPProvider {
  aliases?: string[];
  customGrammars?: any[];
  import: () => Promise<{
    setup: (
      monaco: typeof monacoNS,
      languageId: string,
      langaugeSettings?: Record<string, unknown>,
      formattingOptions?: Record<string, unknown>,
      vfs?: VFS,
    ) => Promise<void>;
    getWorkerUrl: () => URL;
  }>;
}

export interface LSPConfig extends LSPLanguageSettings {
  providers?: Record<string, LSPProvider>;
  format?: FormatOptions;
}

declare global {
  interface LSPLanguageSettings {
    json?: {
      schemas?: JSONSchemaConfiguration[];
    };
    typescript?: {
      /** The extra libraries to be loaded */
      extraLibs?: Record<string, string>;
      /** The compiler options */
      compilerOptions?: ts.CompilerOptions;
      /** The global import maps */
      importMap?: import("./import-map").ImportMap;
      /** The version of the typescript module from CDN */
      version?: string;
    };
  }
}
