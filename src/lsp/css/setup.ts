import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { Workspace } from "~/workspace.ts";
import type { CreateData, CSSWorker } from "./worker.ts";

// ! external modules, don't remove the `.js` extension
import * as client from "../client.js";

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
    fs: workspace ? await client.walkFS(workspace.fs, "/") : undefined,
  };
  const worker = monaco.editor.createWebWorker<CSSWorker>({
    worker: getWorker(createData),
    host: client.createHost(workspace),
  });
  client.init(monaco);

  // register language features
  client.registerBasicFeatures(languageId, worker, ["/", "-", ":", "("], workspace);
  client.registerCodeAction(languageId, worker);
  client.registerColorPresentation(languageId, worker);
  client.registerDocumentLinks(languageId, worker);
}

function createWebWorker(): Worker {
  const workerUrl: URL = new URL("./worker.mjs", import.meta.url);
  if (workerUrl.origin !== location.origin) {
    // create a blob url for cross-origin workers if the url is not same-origin
    return new Worker(
      URL.createObjectURL(new Blob([`import "${workerUrl.href}"`], { type: "application/javascript" })),
      { type: "module", name: "css-worker" },
    );
  }
  return new Worker(workerUrl, { type: "module", name: "css-worker" });
}

function getWorker(createData: CreateData) {
  const worker = createWebWorker();
  worker.postMessage(createData);
  return worker;
}
