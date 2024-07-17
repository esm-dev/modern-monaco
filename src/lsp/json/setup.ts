import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { CreateData, JSONWorker } from "./worker.ts";
import { schemas } from "./schemas.ts";

// ! external modules, don't remove the `.js` extension
import * as lfs from "../language-features.js";

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
  const importMapCodeLensProvider: monacoNS.languages.CodeLensProvider = {
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

  // register code lens provider for import maps
  languages.registerCodeLensProvider(languageId, importMapCodeLensProvider);

  // register command to search npm modules
  editor.registerCommand("search-npm-modules", async (_, uri: string) => {
    const keyword = await monaco.showInputBox({
      placeHolder: "Enter package name, e.g. lodash",
      validateInput: (value) => {
        return /^[\w\.@]+$/.test(value) ? null : "Invalid package name, only word characters are allowed";
      },
    });
    console.log(
      await monaco.showQuickPick(searchPackagesFromNpm(keyword, 32), {
        placeHolder: "Select a package",
        matchOnDetail: true,
      }),
    );
  });
}

async function searchPackagesFromNpm(keyword: string, size = 20) {
  const res = await fetch(`https://registry.npmjs.com/-/v1/search?text=${keyword}&size=${size}`);
  if (!res.ok) {
    throw new Error(`Failed to search npm packages: ${res.statusText}`);
  }
  const { objects } = await res.json();
  return objects.map((o: { package: { name: string; version: string; description: string } }) => ({
    label: o.package.name,
    description: o.package.version,
    detail: o.package.description,
  }));
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
