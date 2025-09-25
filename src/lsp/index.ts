import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { Workspace } from "~/workspace.ts";
import { WorkspaceInit } from "../../types/workspace.js";

export interface LSPModule {
  setup: (
    monaco: typeof monacoNS,
    languageId: string,
    langaugeSettings?: Record<string, unknown>,
    formattingOptions?: FormattingOptions,
    workspace?: Workspace<WorkspaceInit>,
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
    import: () => import("./html/setup.js"),
  },
  css: {
    aliases: ["less", "sass"],
    import: () => import("./css/setup.js"),
  },
  json: {
    import: () => import("./json/setup.js"),
  },
  typescript: {
    aliases: ["javascript", "jsx", "tsx"],
    import: () => import("./typescript/setup.js"),
  },
};
