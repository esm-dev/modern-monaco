import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { CreateData, JSONWorker } from "./worker.ts";
import { schemas } from "./schemas.ts";

// ! external modules, don't remove the `.js` extension
import { parseImportMapFromHtml, parseImportMapFromJson } from "../../import-map.js";
import * as ls from "../language-service.js";

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
        schemas: Array.isArray(languageSettings?.schemas) ? schemas.concat(languageSettings.schemas) : schemas,
        comments: "error",
        trailingCommas: "error",
        schemaRequest: "warning",
        schemaValidation: "warning",
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
  const worker = monaco.editor.createWebWorker<JSONWorker>({
    moduleId: "lsp/json/worker",
    label: languageId,
    createData,
  });
  const workerProxy: ls.WorkerProxy<JSONWorker> = (
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
  ls.setup(monaco);
  ls.enableDefaultFeatures(languageId, workerProxy, [" ", ":", "\""]);

  // register code lens provider for import maps
  languages.registerCodeLensProvider(languageId, {
    provideCodeLenses: function(model, token) {
      const isImportMap = model.uri.scheme == "file"
        && ["importmap.json", "import_map.json", "import-map.json", "importMap.json"].some((name) => model.uri.path === "/" + name);
      if (isImportMap) {
        const m2 = model.findNextMatch(`"imports":\\s*\\{`, { column: 1, lineNumber: 1 }, true, false, null, false);
        return {
          lenses: [
            {
              range: m2?.range ?? new monaco.Range(1, 1, 1, 1),
              id: "search-npm-packages",
              command: {
                id: "search-npm-packages",
                title: "$(sparkle-filled) Search packages on NPM",
                tooltip: "Search packages on NPM",
                arguments: [model.uri.toString()],
              },
            },
          ],
          dispose: () => {},
        };
      }
    },
  });

  // register command to search npm modules
  editor.registerCommand("search-npm-packages", async () => {
    const keyword = await monaco.showInputBox({
      placeHolder: "Enter package name, e.g. lodash",
      validateInput: (value) => {
        return /^[\w\-\.@]+$/.test(value) ? null : "Invalid package name, only word characters are allowed";
      },
    });
    const pkg = await monaco.showQuickPick(searchPackagesFromNpm(keyword, 32), {
      placeHolder: "Select a package",
      matchOnDetail: true,
    });
    const editor = monaco.editor.getEditors().filter(e => e.hasWidgetFocus())[0];
    const model = editor?.getModel();
    if (model) {
      const modelPath = model.uri.path;
      const { imports, scopes } = modelPath.endsWith(".json")
        ? parseImportMapFromJson(model.getValue())
        : parseImportMapFromHtml(model.getValue());
      const specifier = "https://esm.sh/" + pkg.name + "@" + pkg.version;
      if (imports[pkg.name] === specifier) {
        return;
      }
      imports[pkg.name] = specifier;
      const json = JSON.stringify({ imports, scopes: Object.keys(scopes).length > 0 ? scopes : undefined }, null, 2);
      if (modelPath.endsWith(".json")) {
        const viewState = editor.saveViewState();
        model.setValue(model.normalizeIndentation(json));
        editor.restoreViewState(viewState);
      } else if (modelPath.endsWith(".html")) {
        const html = model.getValue();
        const newHtml = html.replace(
          /<script[^>]*? type="importmap"[^>]*?>[^]*?<\/script>/,
          ["<script type=\"importmap\">", ...json.split("\n").map((l) => "  " + l), "</script>"].join("\n  "),
        );
        const viewState = editor.saveViewState();
        model.setValue(model.normalizeIndentation(newHtml));
        editor.restoreViewState(viewState);
      }
    }
  });
}

async function searchPackagesFromNpm(keyword: string, size = 20) {
  const res = await fetch(`https://registry.npmjs.com/-/v1/search?text=${keyword}&size=${size}`);
  if (!res.ok) {
    throw new Error(`Failed to search npm packages: ${res.statusText}`);
  }
  const { objects } = await res.json();
  if (!Array.isArray(objects)) {
    return [];
  }
  const items: (monacoNS.QuickPickItem & { name: string; version: string })[] = new Array(objects.length);
  let len = 0;
  for (let i = 0; i < objects.length; i++) {
    const { package: pkg } = objects[i];
    if (!pkg.name.startsWith("@types/")) {
      items[i] = {
        label: (keyword === pkg.name ? "$(star-empty) " : "") + pkg.name,
        description: pkg.version,
        detail: pkg.description,
        name: pkg.name,
        version: pkg.version,
      };
      len++;
    }
  }
  return items.slice(0, len);
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
