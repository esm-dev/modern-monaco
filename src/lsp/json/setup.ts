import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { CreateData, JSONWorker } from "./worker";
import * as lfs from "../language-features.js";
import { schemas } from "./schemas";

export function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions,
) {
  const { editor, languages } = monaco;
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
  const workerProxy: lfs.WorkerProxy<JSONWorker> = (
    ...uris: monacoNS.Uri[]
  ): Promise<JSONWorker> => {
    return worker.withSyncedResources(uris);
  };

  // reset schema on model change
  const resetSchema = async (uri: monacoNS.Uri) => {
    (await worker.getProxy()).resetSchema(uri.toString());
  };
  editor.onWillDisposeModel((model) => {
    if (model.getLanguageId() === languageId) {
      resetSchema(model.uri);
    }
  });
  editor.onDidChangeModelLanguage((event) => {
    if (event.model.getLanguageId() === languageId) {
      resetSchema(event.model.uri);
    }
  });

  // @ts-expect-error method `onWorker` is added by esm-monaco
  MonacoEnvironment.onWorker(languageId, workerProxy);

  // set monacoNS and register language features
  lfs.setup(monaco);
  lfs.registerDefault(languageId, workerProxy, [" ", ":", "\""]);
  languages.registerCodeLensProvider(languageId, codeLensProvider);
  editor.registerCommand("search-npm-modules", (_, uri: string) => {
    // @ts-expect-error method `getModel` is polluted by esm-monaco for supporting string uri
    return searchModulesFromNpm(editor.getModel(uri));
  });
}

async function searchModulesFromNpm(currentModel: monacoNS.editor.ITextModel) {
  console.log("search-npm-modules", { currentModel: currentModel.uri.toString() });
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
