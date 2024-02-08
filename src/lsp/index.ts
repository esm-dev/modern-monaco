import type * as monacoNS from "monaco-editor-core";
import type { VFS } from "../vfs";

export interface LspLoader {
  aliases?: string[];
  import: () => Promise<{
    setup: (
      languageId: string,
      monaco: typeof monacoNS,
      formatOptions: Record<string, unknown>,
      vfs?: VFS,
    ) => Promise<void>;
    workerUrl: () => URL;
  }>;
}

export function normalizeFormatOptions(
  label: string,
  formatOptions?: Record<string, unknown>,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (!formatOptions) {
    return options;
  }
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
      // ignore
    } else {
      continue;
    }
    options[key] = value;
  }
  return options;
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
