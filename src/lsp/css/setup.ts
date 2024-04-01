import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { CreateData, CSSWorker } from "./worker";
import * as lfs from "../language-features.js";

export function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions,
) {
  const languages = monaco.languages;
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
  const workerProxy: lfs.WorkerProxy<CSSWorker> = (
    ...uris: monacoNS.Uri[]
  ): Promise<CSSWorker> => {
    return worker.withSyncedResources(uris);
  };

  // @ts-expect-error `onWorker` is added by esm-monaco
  MonacoEnvironment.onWorker(languageId, workerProxy);

  // set monacoNS and register language features
  lfs.setup(monaco);
  lfs.registerDefault(languageId, workerProxy, ["/", "-", ":"]);
  languages.registerColorProvider(languageId, new lfs.DocumentColorAdapter(workerProxy));
  languages.registerDefinitionProvider(languageId, new lfs.DefinitionAdapter(workerProxy));
  languages.registerReferenceProvider(languageId, new lfs.ReferenceAdapter(workerProxy));
  languages.registerDocumentHighlightProvider(languageId, new lfs.DocumentHighlightAdapter(workerProxy));
  languages.registerRenameProvider(languageId, new lfs.RenameAdapter(workerProxy));
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
