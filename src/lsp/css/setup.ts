import type monacoNS from "monaco-editor-core";
import type { CreateData, CSSWorker } from "./worker";

// ! external module, don't remove the `.js` extension
import * as lf from "../language-features.js";

export function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: Record<string, unknown>,
) {
  const languages = monaco.languages;
  const diagnosticsEmitter = new monaco.Emitter<void>();
  const createData: CreateData = {
    languageId,
    options: {
      data: {
        useDefaultDataProvider: true,
      },
      format: {
        tabSize: 4,
        insertSpaces: false,
        insertFinalNewline: true,
        newlineBetweenSelectors: true,
        newlineBetweenRules: true,
        spaceAroundSelectorSeparator: false,
        braceStyle: "collapse",
        preserveNewLines: true,
        ...formattingOptions,
      },
    },
  };
  const worker = monaco.editor.createWebWorker<CSSWorker>({
    moduleId: "lsp/css/worker",
    label: languageId,
    createData,
  });
  const workerAccessor: lf.WorkerAccessor<CSSWorker> = (
    ...uris: monacoNS.Uri[]
  ): Promise<CSSWorker> => {
    return worker.withSyncedResources(uris);
  };

  // @ts-expect-error `onWorker` is added by esm-monaco
  MonacoEnvironment.onWorker(languageId, workerAccessor);

  // set monacoNS and register default language features
  lf.setup(monaco);
  lf.registerDefault(languageId, workerAccessor, ["/", "-", ":"]);

  // register diagnostics adapter
  new lf.DiagnosticsAdapter(languageId, workerAccessor, diagnosticsEmitter.event);

  // register language features
  languages.registerColorProvider(languageId, new lf.DocumentColorAdapter(workerAccessor));
  languages.registerDocumentHighlightProvider(languageId, new lf.DocumentHighlightAdapter(workerAccessor));
  languages.registerRenameProvider(languageId, new lf.RenameAdapter(workerAccessor));

  // disable definition and reference providers for now
  // languages.registerDefinitionProvider(languageId, new lf.DefinitionAdapter(workerAccessor));
  // languages.registerReferenceProvider(languageId, new lf.ReferenceAdapter(workerAccessor));
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
