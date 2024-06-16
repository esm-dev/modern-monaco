import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { VFS } from "../vfs.ts";
import jsonScriptTag from "./html/syntaxes/json-script-tag.json";

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
  syntaxes?: any[];
  import: () => Promise<LSP>;
}

export interface LSPConfig {
  format?: FormattingOptions;
  providers?: Record<string, LSPProvider>;
}

export const builtinProviders: Record<string, LSPProvider> = {
  html: {
    syntaxes: [jsonScriptTag],
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
    aliases: ["javascript", "jsx", "tsx"],
    // @ts-expect-error 'setup.js' is generated at build time
    import: () => import("./lsp/typescript/setup.js"),
  },
};

export async function createWorker(url: URL): Promise<Worker> {
  if (url.origin !== location.origin) {
    const workerBlob = new Blob([`import "${url.href}"`], { type: "application/javascript" });
    return new Worker(URL.createObjectURL(workerBlob), {
      type: "module",
      name: url.pathname.slice(1),
    });
  }
  return new Worker(url, { type: "module" });
}

export function margeProviders(config?: LSPConfig) {
  return { ...builtinProviders, ...config?.providers };
}
