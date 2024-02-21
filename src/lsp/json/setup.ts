import type monacoNS from "monaco-editor-core";
import type { CreateData, JSONWorker } from "./worker";
import { schemas } from "./schemas";

// don't change below code, the 'language-features.js' is an external module generated at build time.
import * as lf from "../language-features.js";

export function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  format?: Record<string, unknown>,
) {
  // register monacoNS for language features module
  lf.prelude(monaco);

  const languages = monaco.languages;
  const events = new monaco.Emitter<void>();
  const createData: CreateData = {
    languageId,
    options: {
      settings: {
        validate: true,
        allowComments: false,
        schemaRequest: "warning",
        schemaValidation: "warning",
        comments: "error",
        trailingCommas: "error",
        ...languageSettings,
        schemas: Array.isArray(languageSettings?.schemas) ? schemas.concat(languageSettings.schemas) : schemas,
      },
      format: {
        tabSize: 4,
        insertSpaces: false,
        trimTrailingWhitespace: true,
        insertFinalNewline: true,
        ...format,
      },
    },
  };
  const worker = monaco.editor.createWebWorker<JSONWorker>({
    moduleId: "lsp/json/worker",
    label: languageId,
    createData,
  });
  const workerAccessor: lf.WorkerAccessor<JSONWorker> = (
    ...uris: monacoNS.Uri[]
  ): Promise<JSONWorker> => {
    return worker.withSyncedResources(uris);
  };

  class JSONDiagnosticsAdapter extends lf.DiagnosticsAdapter<JSONWorker> {
    constructor(
      languageId: string,
      worker: lf.WorkerAccessor<JSONWorker>,
    ) {
      super(languageId, worker, events.event);
      const editor = monaco.editor;
      editor.onWillDisposeModel((model) => {
        this._resetSchema(model.uri);
      });
      editor.onDidChangeModelLanguage((event) => {
        this._resetSchema(event.model.uri);
      });
    }

    private _resetSchema(resource: monacoNS.Uri): void {
      this._worker().then((worker) => {
        worker.resetSchema(resource.toString());
      });
    }
  }

  languages.registerDocumentFormattingEditProvider(
    languageId,
    new lf.DocumentFormattingEditProvider(workerAccessor),
  );
  languages.registerDocumentRangeFormattingEditProvider(
    languageId,
    new lf.DocumentRangeFormattingEditProvider(workerAccessor),
  );
  languages.registerCompletionItemProvider(
    languageId,
    new lf.CompletionAdapter(workerAccessor, [" ", ":", '"']),
  );
  languages.registerHoverProvider(
    languageId,
    new lf.HoverAdapter(workerAccessor),
  );
  languages.registerDocumentSymbolProvider(
    languageId,
    new lf.DocumentSymbolAdapter(workerAccessor),
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
  new JSONDiagnosticsAdapter(languageId, workerAccessor);

  const codeLensEmitter = new monaco.Emitter<monacoNS.languages.CodeLensProvider>();
  languages.registerCodeLensProvider(languageId, {
    onDidChange: codeLensEmitter.event,
    resolveCodeLens: (model, codeLens, token) => {
      return codeLens;
    },
    provideCodeLenses: function (model, token) {
      const isImportMap = ["importmap.json", "import_map.json", "import-map.json", "importMap.json"].some((name) =>
        model.uri.path === "/" + name
      );
      if (isImportMap) {
        const m2 = model.findNextMatch(
          `"imports":\\s*\\{`,
          { column: 1, lineNumber: 1 },
          true,
          false,
          null,
          false,
        );
        return {
          lenses: [
            {
              range: m2?.range ?? new monaco.Range(1, 1, 1, 1),
              id: "search-npm-modules",
              command: {
                id: "search-npm-modules",
                title: "✦ Search modules on NPM",
                arguments: [model.uri.toString()],
              },
            },
          ],
          dispose: () => {},
        };
      }
    },
  });
}

export function workerUrl() {
  const m = workerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found");
  const url = new URL(m[1], import.meta.url);
  Reflect.set(url, "import", () => import("./worker.js")); // trick for bundlers
  return url;
}
