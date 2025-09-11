import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { Workspace } from "~/workspace.ts";
import type { CreateData, CSSWorker } from "./worker.ts";

// ! external modules, don't remove the `.js` extension
import * as ls from "../language-service.js";

export async function setup(
  monaco: typeof monacoNS,
  languageId: string,
  workspace?: Workspace,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions,
) {
  const { tabSize, insertSpaces, insertFinalNewline, trimFinalNewlines } = formattingOptions ?? {};
  const createData: CreateData = {
    language: languageId as "css" | "less" | "scss",
    data: {
      useDefaultDataProvider: true,
      // todo: custom data provider
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
    workspace: !!workspace,
  };
  const worker = monaco.editor.createWebWorker<CSSWorker>({
    moduleId: "lsp/css/worker",
    label: languageId,
    createData,
    host: ls.createHost(workspace),
  });

  // register language features
  ls.registerBasicFeatures(languageId, worker, ["/", "-", ":", "("], workspace);
  ls.registerCodeAction(languageId, worker);
  ls.registerColorPresentation(languageId, worker);
  ls.registerDocumentLinks(languageId, worker);
}

export function getWorker() {
  return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
}
