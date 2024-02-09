import type * as monacoNS from "monaco-editor-core";
import * as lf from "../language-features";
import type { CreateData, CSSWorker } from "./worker";

export function setup(
  languageId: string,
  monaco: typeof monacoNS,
  format?: Record<string, unknown>,
) {
  const languages = monaco.languages;
  const events = new monaco.Emitter<void>();
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
        ...format,
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

  lf.prelude(monaco);
  languages.registerCompletionItemProvider(
    languageId,
    new lf.CompletionAdapter(workerAccessor, ["/", "-", ":"]),
  );
  languages.registerHoverProvider(
    languageId,
    new lf.HoverAdapter(workerAccessor),
  );
  languages.registerDocumentHighlightProvider(
    languageId,
    new lf.DocumentHighlightAdapter(workerAccessor),
  );
  languages.registerDefinitionProvider(
    languageId,
    new lf.DefinitionAdapter(workerAccessor),
  );
  languages.registerReferenceProvider(
    languageId,
    new lf.ReferenceAdapter(workerAccessor),
  );
  languages.registerDocumentSymbolProvider(
    languageId,
    new lf.DocumentSymbolAdapter(workerAccessor),
  );
  languages.registerRenameProvider(
    languageId,
    new lf.RenameAdapter(workerAccessor),
  );
  languages.registerColorProvider(
    languageId,
    new lf.DocumentColorAdapter(workerAccessor),
  );
  languages.registerFoldingRangeProvider(
    languageId,
    new lf.FoldingRangeAdapter(workerAccessor),
  );
  languages.registerSelectionRangeProvider(
    languageId,
    new lf.SelectionRangeAdapter(workerAccessor),
  );
  languages.registerDocumentFormattingEditProvider(
    languageId,
    new lf.DocumentFormattingEditProvider(workerAccessor),
  );
  languages.registerDocumentRangeFormattingEditProvider(
    languageId,
    new lf.DocumentRangeFormattingEditProvider(workerAccessor),
  );
  new lf.DiagnosticsAdapter(
    languageId,
    workerAccessor,
    events.event,
  );
}

export function workerUrl() {
  const m = workerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found");
  const url = new URL(m[1], import.meta.url);
  Reflect.set(url, "import", () => import("./worker.js")); // trick for bundlers
  return url;
}
