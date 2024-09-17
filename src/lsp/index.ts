import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { VFS } from "../vfs.ts";

export interface LSP {
  setup: (
    monaco: typeof monacoNS,
    languageId: string,
    langaugeSettings?: Record<string, unknown>,
    formattingOptions?: FormattingOptions,
    vfs?: VFS,
  ) => void | Promise<void>;
  getWorkerUrl: () => URL;
}

export interface LSPProvider {
  aliases?: string[];
  import: () => Promise<LSP>;
}

export interface LSPConfig {
  format?: FormattingOptions;
  providers?: Record<string, LSPProvider>;
  typescript?: { tsVersion?: string };
}

export const builtinProviders: Record<string, LSPProvider> = {
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

export function createWebWorker(url: URL, name?: string): Worker {
  let workerUrl: URL | string = url;
  // create a blob url for cross-origin workers if the url is not same-origin
  if (url.origin !== location.origin) {
    workerUrl = URL.createObjectURL(
      new Blob(
        [`import "${url.href}"`],
        { type: "application/javascript" },
      ),
    );
  }
  return new Worker(workerUrl, {
    type: "module",
    name: name ?? url.pathname.slice(1).split("/").slice(-2).join("/"),
  });
}

export function margeProviders(config?: LSPConfig) {
  return { ...builtinProviders, ...config?.providers };
}
