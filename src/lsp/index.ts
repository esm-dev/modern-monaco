import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { Workspace } from "~/workspace.ts";

export interface LSPModule {
  setup: (
    monaco: typeof monacoNS,
    languageId: string,
    workspace?: Workspace,
    langaugeSettings?: Record<string, unknown>,
    formattingOptions?: FormattingOptions,
  ) => void | Promise<void>;
}

export interface LSPProvider {
  aliases?: string[];
  import: () => Promise<LSPModule>;
}

export interface LSPConfig {
  providers?: Record<string, LSPProvider>;
  formatting?: FormattingOptions;
}

export const builtinLSPProviders: Record<string, LSPProvider> = {
  html: {
    // @ts-expect-error 'setup.js' is generated at build time
    import: () => import("./lsp/html/setup.js"),
  },
  css: {
    aliases: ["less", "sass"],
    // @ts-expect-error 'setup.js' is generated at build time
    import: () => import("./lsp/css/setup.js"),
  },
  json: {
    // @ts-expect-error 'setup.js' is generated at build time
    import: () => import("./lsp/json/setup.js"),
  },
  typescript: {
    aliases: ["javascript", "jsx", "tsx"],
    // @ts-expect-error 'setup.js' is generated at build time
    import: () => import("./lsp/typescript/setup.js"),
  },
};
