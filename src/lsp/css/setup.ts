import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { Workspace } from "~/workspace.ts";
import type { CreateData, CSSWorker } from "./worker.ts";

// ! external modules, don't remove the `.js` extension
import * as ls from "../language-service.js";

export async function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions,
  workspace?: Workspace,
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
    worker: ls.createWebWorker(getWorkerUrl(), createData),
    host: ls.createHost(workspace),
  });

  // register language features
  ls.registerBasicFeatures(languageId, worker, ["/", "-", ":", "("], workspace);
  ls.registerCodeAction(languageId, worker);
  ls.registerColorPresentation(languageId, worker);
  ls.registerDocumentLinks(languageId, worker);
}

function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
