import type monacoNS from "monaco-editor-core";
import type { VFS } from "../vfs";

export interface LSPLoader {
  aliases?: string[];
  import: () => Promise<{
    setup: (
      monaco: typeof monacoNS,
      languageId: string,
      langaugeSettings?: Record<string, unknown>,
      formatOptions?: Record<string, unknown>,
      vfs?: VFS,
    ) => Promise<void>;
    workerUrl: () => URL;
  }>;
}

export function normalizeFormatOptions(
  label: string,
  formatOptions?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!formatOptions) {
    return undefined;
  }
  const options: Record<string, unknown> = {};
  if (label in formatOptions) {
    Object.assign(options, formatOptions[label]);
  }
  for (let key in formatOptions) {
    let value = formatOptions[key];
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
  if (url.hostname === "esm.sh") {
    const { default: workerFactory } = await import(
      url.href.replace(/\.js$/, ".bundle.js") + "?worker"
    );
    return workerFactory() as Worker;
  }
  return new Worker(url, { type: "module" });
}

export default <Record<string, LSPLoader>> {
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
