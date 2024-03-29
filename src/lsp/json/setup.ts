import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { CreateData, JSONWorker } from "./worker";
import { schemas } from "./schemas";

// ! external module, don't remove the `.js` extension
import * as lf from "../language-features.js";

export function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions,
) {
  const { editor, languages } = monaco;
  const diagnosticsEmitter = new monaco.Emitter<void>();
  const codeLensEmitter = new monaco.Emitter<monacoNS.languages.CodeLensProvider>();
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
        trimFinalNewlines: true,
        ...formattingOptions,
      },
    },
  };
  const codeLensProvider: monacoNS.languages.CodeLensProvider = {
    onDidChange: codeLensEmitter.event,
    resolveCodeLens: (model, codeLens, token) => {
      return codeLens;
    },
    provideCodeLenses: function(model, token) {
      const isImportMap = ["importmap.json", "import_map.json", "import-map.json", "importMap.json"].some((name) =>
        model.uri.path === "/" + name
      );
      if (isImportMap) {
        const m2 = model.findNextMatch(`"imports":\\s*\\{`, { column: 1, lineNumber: 1 }, true, false, null, false);
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
  };
  const worker = monaco.editor.createWebWorker<JSONWorker>({
    moduleId: "lsp/json/worker",
    label: languageId,
    createData,
  });
  const workerProxy: lf.WorkerProxy<JSONWorker> = (
    ...uris: monacoNS.Uri[]
  ): Promise<JSONWorker> => {
    return worker.withSyncedResources(uris);
  };

  // reset schema on model change
  const resetSchema = (uri: monacoNS.Uri) => {
    return worker.getProxy().then((worker) => {
      worker.resetSchema(uri.toString());
    });
  };
  editor.onWillDisposeModel((model) => {
    resetSchema(model.uri);
  });
  editor.onDidChangeModelLanguage((event) => {
    resetSchema(event.model.uri);
  });

  // @ts-expect-error `onWorker` is added by esm-monaco
  MonacoEnvironment.onWorker(languageId, workerProxy);

  // set monacoNS and register language features
  lf.setup(monaco);
  lf.registerDefault(languageId, workerProxy, [" ", ":", "\""]);
  languages.registerCodeLensProvider(languageId, codeLensProvider);

  // register diagnostics adapter
  new lf.DiagnosticsAdapter(languageId, workerProxy, diagnosticsEmitter.event);
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
