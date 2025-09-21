import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { Workspace } from "~/workspace.ts";
import type { CreateData, JSONWorker } from "./worker.ts";
import { parseImportMapFromHtml, parseImportMapFromJson } from "@esm.sh/import-map";
import { schemas } from "./schemas.ts";

// ! external modules, don't remove the `.js` extension
import * as ls from "../language-service.js";

export async function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions,
  workspace?: Workspace,
) {
  const { editor, languages } = monaco;
  const createData: CreateData = {
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
    workspace: !!workspace,
  };
  const worker = editor.createWebWorker<JSONWorker>({
    worker: getWorker(createData),
    host: ls.createHost(workspace),
  });

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

  // register language features
  ls.registerBasicFeatures(languageId, worker, [" ", ":", '"'], workspace);
  ls.registerColorPresentation(languageId, worker);
  ls.registerDocumentLinks(languageId, worker);

  // register code lens provider for import maps
  languages.registerCodeLensProvider(languageId, {
    provideCodeLenses: function(model, _token) {
      const isImportMap = model.uri.scheme == "file"
        && ["importmap.json", "import_map.json", "import-map.json", "importMap.json"].some((name) => model.uri.path === "/" + name);
      if (isImportMap) {
        const m2 = model.findNextMatch(`"imports":\\s*\\{`, { column: 1, lineNumber: 1 }, true, false, null, false);
        return {
          lenses: [
            {
              range: m2?.range ?? new monaco.Range(1, 1, 1, 1),
              command: {
                id: "search-npm-package",
                title: "$(sparkle-filled) Search packages on NPM",
                tooltip: "Search packages on NPM",
                arguments: [model],
              },
            },
          ],
          dispose: () => {},
        };
      }
    },
  });

  // register command to search npm modules
  editor.registerCommand("search-npm-package", async (_accessor: any, model: monacoNS.editor.ITextModel) => {
    const keyword = await monaco.showInputBox({
      placeHolder: "Enter package name, e.g. lodash",
      validateInput: (value) => {
        return /^[\w\-\.@]+$/.test(value) ? null : "Invalid package name, only word characters are allowed";
      },
    });
    if (!keyword) {
      return;
    }
    const pkg = await monaco.showQuickPick(searchPackagesFromNpm(keyword, 32), {
      placeHolder: "Select a package",
      matchOnDetail: true,
    });
    if (!pkg) {
      return;
    }
    const editor = monaco.editor.getEditors().filter(e => e.hasWidgetFocus())[0];
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
      const viewState = editor?.saveViewState();
      model.setValue(model.normalizeIndentation(json));
      editor?.restoreViewState(viewState);
    } else if (modelPath.endsWith(".html")) {
      const html = model.getValue();
      const newHtml = html.replace(
        /<script[^>]*? type="importmap"[^>]*?>[^]*?<\/script>/,
        ['<script type="importmap">', ...json.split("\n").map((l) => "  " + l), "</script>"].join("\n  "),
      );
      const viewState = editor?.saveViewState();
      model.setValue(model.normalizeIndentation(newHtml));
      editor?.restoreViewState(viewState);
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
  for (const { package: pkg } of objects) {
    if (!pkg.name.startsWith("@types/")) {
      items[len] = {
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

function createWebWorker(): Worker {
  const workerUrl: URL = new URL("./worker.mjs", import.meta.url);
  // create a blob url for cross-origin workers if the url is not same-origin
  if (workerUrl.origin !== location.origin) {
    return new Worker(
      URL.createObjectURL(new Blob([`import "${workerUrl.href}"`], { type: "application/javascript" })),
      { type: "module", name: "json-worker" },
    );
  }
  return new Worker(workerUrl, { type: "module", name: "json-worker" });
}

function getWorker(createData: CreateData) {
  const worker = createWebWorker();
  worker.postMessage(createData);
  return worker;
}
