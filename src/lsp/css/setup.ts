import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { CreateData, CSSWorker } from "./worker.ts";

// ! external modules, don't remove the `.js` extension
import * as ls from "../language-service.js";

export function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions,
) {
  const { tabSize, insertSpaces, insertFinalNewline, trimFinalNewlines } = formattingOptions ?? {};
  const createData: CreateData = {
    options: {
      data: {
        useDefaultDataProvider: true,
      },
      format: {
        tabSize,
        insertFinalNewline,
        insertSpaces,
        preserveNewLines: !trimFinalNewlines,
        newlineBetweenSelectors: true,
        newlineBetweenRules: true,
        spaceAroundSelectorSeparator: false,
        braceStyle: "collapse",
      },
    },
  };
  const worker = monaco.editor.createWebWorker<CSSWorker>({
    moduleId: "lsp/css/worker",
    label: languageId,
    createData,
  });

  // set monacoNS and register language features
  ls.setup(monaco);
  ls.enableBasicFeatures(languageId, worker, ["/", "-", ":"]);
  ls.enableCodeAction(languageId, worker);
  ls.enableColorPresentation(languageId, worker);
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
