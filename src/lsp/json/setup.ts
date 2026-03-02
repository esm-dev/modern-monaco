import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { DocumentLanguageSettings, LanguageSettings } from "vscode-json-languageservice";
import type { Workspace } from "~/workspace.ts";
import type { DiagnosticsOptions } from "~/lsp/client.ts";
import type { CreateData, JSONWorker } from "./worker.ts";
import { parseFromHtml, parseFromJson, setFetcher } from "@esm.sh/import-map";
import { schemas as builtinSchemas } from "./schemas.ts";

// ! external modules, don't remove the `.js` extension
import { cache } from "../../cache.js";
import * as client from "../client.js";

interface JSONLanguageSettings extends LanguageSettings, DocumentLanguageSettings {
  importMapCodeLens?: boolean;
  diagnosticsOptions?: DiagnosticsOptions;
}

export async function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: JSONLanguageSettings,
  formattingOptions?: FormattingOptions,
  workspace?: Workspace,
) {
  const { editor, languages } = monaco;
  const schemas = Array.isArray(languageSettings?.schemas) ? builtinSchemas.concat(languageSettings.schemas) : builtinSchemas;
  const createData: CreateData = {
    settings: {
      validate: languageSettings?.diagnosticsOptions?.validate ?? true,
      allowComments: false,
      comments: "error",
      trailingCommas: "error",
      schemaRequest: "warning",
      schemaValidation: "warning",
      ...languageSettings,
      schemas,
    },
    format: {
      tabSize: 4,
      insertSpaces: false,
      trimTrailingWhitespace: true,
      insertFinalNewline: true,
      trimFinalNewlines: true,
      ...formattingOptions,
    },
    fs: workspace ? await client.walkFS(workspace.fs, "/") : undefined,
  };
  const worker = editor.createWebWorker<JSONWorker>({
    worker: getWorker(createData),
    host: client.createHost(workspace),
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

  // initialize lsp client
  client.init(monaco);

  // register language features
  client.registerBasicFeatures(languageId, worker, [" ", ":", '"'], workspace, languageSettings?.diagnosticsOptions);
  client.registerColorPresentation(languageId, worker);
  client.registerDocumentLinks(languageId, worker);

  // register code lens provider for import maps
  if (languageSettings?.importMapCodeLens ?? true) {
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
                  id: "importmap:add-import",
                  title: "$(sparkle-filled) Add import from esm.sh",
                  tooltip: "Add Import",
                  arguments: [model],
                },
              },
            ],
            dispose: () => {},
          };
        }
      },
    });
  }

  // set the fetcher for `addImport`
  setFetcher(cache.fetch.bind(cache));

  // register command to search npm modules
  editor.registerCommand("importmap:add-import", async (_accessor: any, model: monacoNS.editor.ITextModel) => {
    const specifier = await monaco.showInputBox({
      placeHolder: "Enter package name, e.g. react, react@18, react-dom@beta, etc.",
      validateInput: (value) => /^[\w\-\.\/@]+$/.test(value) ? null : "Invalid package name",
    });
    if (!specifier) {
      return;
    }

    const modelPath = model.uri.path;
    const im = modelPath.endsWith(".json") ? parseFromJson(model.getValue()) : parseFromHtml(model.getValue());

    const items = await createModulePickItems(specifier, im.config?.cdn);
    const imports = items.length > 1
      ? await monaco.showQuickPick(items, {
        placeHolder: "Select modules to add",
        canPickMany: true,
      })
      : items;
    if (!imports || imports.length === 0) {
      return;
    }

    // add imports to import map
    await Promise.all(imports.map(async (module) => im.addImport(module.specifier, true)));

    const json = JSON.stringify(im.raw, null, 2);
    const editor = monaco.editor.getEditors().filter(e => e.hasWidgetFocus())[0];
    const viewState = editor?.saveViewState();
    if (modelPath.endsWith(".html")) {
      const html = model.getValue();
      const newHtml = html.replace(
        /<script[^>]*? type="importmap"[^>]*?>[^]*?<\/script>/,
        ['<script type="importmap">', ...json.split("\n").map((l) => "  " + l), "</script>"].join("\n  "),
      );
      model.setValue(model.normalizeIndentation(newHtml));
    } else if (modelPath.endsWith(".json")) {
      model.setValue(model.normalizeIndentation(json));
    }
    editor?.restoreViewState(viewState);
  });
}

async function createModulePickItems(specifier: string, cdn?: string): Promise<(monacoNS.QuickPickItem & { specifier: string })[]> {
  if (!cdn || !(cdn.startsWith("https://") || cdn.startsWith("http://"))) {
    cdn = "https://esm.sh";
  }
  const res = await cache.fetch(new URL(`/${specifier}?meta`, cdn));
  if (!res.ok) {
    throw new Error(`Failed to fetch module metadata of ${specifier}: ${res.statusText}`);
  }
  const { name, version, exports } = await res.json();
  const items: (monacoNS.QuickPickItem & { specifier: string })[] = [{
    label: name,
    description: "@" + version + " main-module",
    picked: true,
    specifier: name + "@" + version,
  }];
  if (exports) {
    const subModules = (exports as string[]).filter((subModule) =>
      subModule.startsWith("./")
      && !subModule.endsWith(".json")
      && !subModule.endsWith(".wasm")
      && !subModule.endsWith(".css")
    );
    subModules.forEach((subModule, index) => {
      const treeChar = index === subModules.length - 1 ? "└" : "├";
      items.push({
        label: " " + treeChar + " " + subModule.slice(2),
        description: "sub-module",
        specifier: name + "@" + version + subModule.slice(1),
      });
    });
  }
  return items;
}

function createWebWorker(): Worker {
  const workerUrl: URL = new URL("./worker.mjs", import.meta.url);
  if (workerUrl.origin !== location.origin) {
    // create a blob url for cross-origin workers if the url is not same-origin
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
