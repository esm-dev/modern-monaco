import type monacoNS from "monaco-editor-core";
import type { VFS } from "../vfs.ts";
import jsonScriptGrammar from "./html/json-script.embedded.json";

export interface LSPConfig {
  customGrammars?: import("@shikijs/core").LanguageRegistration[];
  aliases?: string[];
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

export function normalizeFormattingOptions(
  label: string,
  formattingOptions?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!formattingOptions) {
    return undefined;
  }
  const options: Record<string, unknown> = {};
  if (label in formattingOptions) {
    Object.assign(options, formattingOptions[label]);
  }
  for (let key in formattingOptions) {
    let value = formattingOptions[key];
    if (key === "insertSpaces") {
      if (label === "typescript") {
        key = "convertTabsToSpaces";
      }
    } else if (key === "insertFinalNewline") {
      if (label === "html") {
        key = "endWithNewline";
      }
    } else if (key === "trimFinalNewlines") {
      if (label === "html" || label === "css") {
        key = "preserveNewLines";
        value = !value;
      }
    } else if (key === "tabSize" || key === "trimTrailingWhitespace") {
      // keep
    } else {
      continue;
    }
    if (!(key in options)) {
      options[key] = value;
    }
  }
  return options;
}

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

export const lspConfig: Record<string, LSPConfig> = {
  html: {
    // @ts-expect-error 'setup.js' is generated at build time
    import: () => import("./lsp/html/setup.js"),
    customGrammars: [jsonScriptGrammar as any],
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
    aliases: ["javascript", "jsx", "tsx"],
  },
};
