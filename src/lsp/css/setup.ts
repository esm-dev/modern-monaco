import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { CreateData, CSSWorker } from "./worker";

// ! external module, don't remove the `.js` extension
import * as lf from "../language-features.js";

export function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions,
) {
  const languages = monaco.languages;
  const diagnosticsEmitter = new monaco.Emitter<void>();
  const { tabSize, insertSpaces, insertFinalNewline, trimFinalNewlines } = formattingOptions ?? {};
  const createData: CreateData = {
    languageId,
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
  const workerProxy: lf.WorkerProxy<CSSWorker> = (
    ...uris: monacoNS.Uri[]
  ): Promise<CSSWorker> => {
    return worker.withSyncedResources(uris);
  };

  // @ts-expect-error `onWorker` is added by esm-monaco
  MonacoEnvironment.onWorker(languageId, workerProxy);

  // set monacoNS and register default language features
  lf.setup(monaco);
  lf.registerDefault(languageId, workerProxy, ["/", "-", ":"]);

  // register diagnostics adapter
  new lf.DiagnosticsAdapter(languageId, workerProxy, diagnosticsEmitter.event);

  // register language features
  languages.registerColorProvider(languageId, new lf.DocumentColorAdapter(workerProxy));
  languages.registerDocumentHighlightProvider(languageId, new lf.DocumentHighlightAdapter(workerProxy));
  languages.registerRenameProvider(languageId, new lf.RenameAdapter(workerProxy));
  languages.registerDefinitionProvider(languageId, new lf.DefinitionAdapter(workerProxy));

  // disable reference providers for now
  // languages.registerReferenceProvider(languageId, new lf.ReferenceAdapter(workerProxy));
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
