import type * as monacoNS from "monaco-editor-core";
import type { VFS } from "../vfs";
import type { FormattingOptions } from "vscode-languageserver-types";

export interface LspLoader {
  aliases?: string[];
  import: () => Promise<{
    setup: (
      languageId: string,
      monaco: typeof monacoNS,
      vfs?: VFS,
      format?: FormattingOptions,
      languageOptions?: Record<string, unknown>,
    ) => Promise<void>;
    workerUrl: () => URL;
  }>;
}

export default <Record<string, LspLoader>> {
  html: {
    // @ts-expect-error 'setup.js' is generated at build time
    import: () => import("./lsp/html/setup.js"),
  },
  css: {
    // @ts-expect-error 'setup.js' is generated at build time
    import: () => import("./lsp/css/setup.js"),
  },
  json: {
    // @ts-expect-error 'setup.js' is generated at build time
    import: () => import("./lsp/json/setup.js"),
  },
  typescript: {
    // @ts-expect-error 'setup.js' is generated at build time
    import: () => import("./lsp/typescript/setup.js"),
    aliases: ["javascript", "tsx"],
  },
};
