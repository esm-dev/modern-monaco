import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { HTMLDataV1 } from "vscode-html-languageservice";
import type { Workspace } from "~/workspace.ts";
import type { DiagnosticsOptions } from "~/lsp/client.ts";
import type { CreateData, HTMLWorker } from "./worker.ts";

// ! external modules, don't remove the `.js` extension
import * as client from "../client.js";

interface HTMLLanguageSettings {
  useDefaultDataProvider?: boolean;
  dataProviders?: { [providerId: string]: HTMLDataV1 };
  customTags?: HTMLDataV1["tags"];
  attributeDefaultValue?: "empty" | "singlequotes" | "doublequotes";
  hideAutoCompleteProposals?: boolean;
  hideEndTagSuggestions?: boolean;
  importMapCodeLens?: boolean;
  diagnosticsOptions?: DiagnosticsOptions;
}

export async function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: HTMLLanguageSettings,
  formattingOptions?: FormattingOptions,
  workspace?: Workspace,
) {
  const { editor, languages } = monaco;
  const { tabSize, insertSpaces, insertFinalNewline, trimFinalNewlines } = formattingOptions ?? {};
  const dataProviders = { ...languageSettings?.dataProviders };
  if (languageSettings?.customTags) {
    dataProviders["#custom-tags"] = { version: 1.1, tags: languageSettings.customTags };
  }
  const createData: CreateData = {
    suggest: {
      attributeDefaultValue: languageSettings?.attributeDefaultValue,
      hideAutoCompleteProposals: languageSettings?.hideAutoCompleteProposals,
      hideEndTagSuggestions: languageSettings?.hideEndTagSuggestions,
    },
    format: {
      tabSize,
      insertSpaces,
      endWithNewline: insertFinalNewline,
      preserveNewLines: !trimFinalNewlines,
      maxPreserveNewLines: 1,
      indentInnerHtml: false,
      indentHandlebars: false,
      unformatted:
        'default": "a, abbr, acronym, b, bdo, big, br, button, cite, code, dfn, em, i, img, input, kbd, label, map, object, q, samp, select, small, span, strong, sub, sup, textarea, tt, var',
      contentUnformatted: "pre",
      // extraLiners: "head, body, /html",
      extraLiners: "",
      wrapAttributes: "auto",
    },
    data: {
      useDefaultDataProvider: languageSettings?.useDefaultDataProvider ?? true,
      dataProviders,
    },
    fs: workspace ? await client.walkFS(workspace.fs, "/") : undefined,
  };
  const htmlWorker = editor.createWebWorker<HTMLWorker>({
    worker: getWorker(createData),
    host: client.createHost(workspace),
  });
  const workerWithEmbeddedLanguages = client.createWorkerWithEmbeddedLanguages(htmlWorker);

  // initialize lsp client
  client.init(monaco);

  // register language features
  client.registerBasicFeatures(
    languageId,
    workerWithEmbeddedLanguages,
    ["<", "/", "=", '"'],
    workspace,
    languageSettings?.diagnosticsOptions,
  );
  client.registerAutoComplete(languageId, workerWithEmbeddedLanguages, [">", "/", "="]);
  client.registerColorPresentation(languageId, workerWithEmbeddedLanguages); // css color presentation
  client.registerDocumentLinks(languageId, workerWithEmbeddedLanguages);

  // support embedded languages(css, javascript and importmap) in html files
  client.registerEmbedded(languageId, workerWithEmbeddedLanguages, ["css", "javascript", "importmap"]);

  // register code lens provider for import maps
  if (languageSettings?.importMapCodeLens ?? true) {
    languages.registerCodeLensProvider(languageId, {
      provideCodeLenses: (model, _token) => {
        const m = model.findNextMatch(
          `<script\\s[^>]*?type=['"]importmap['"]`,
          { lineNumber: 4, column: 1 },
          true,
          false,
          null,
          false,
        );
        if (m) {
          const m2 = model.findNextMatch(
            `"imports":\\s*\\{`,
            m.range.getEndPosition(),
            true,
            false,
            null,
            false,
          );
          return {
            lenses: [
              {
                range: (m2 ?? m).range,
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
}

function createWebWorker(): Worker {
  const workerUrl: URL = new URL("./worker.mjs", import.meta.url);
  if (workerUrl.origin !== location.origin) {
    // create a blob url for cross-origin workers if the url is not same-origin
    return new Worker(
      URL.createObjectURL(new Blob([`import "${workerUrl.href}"`], { type: "application/javascript" })),
      { type: "module", name: "html-worker" },
    );
  }
  return new Worker(workerUrl, { type: "module", name: "html-worker" });
}

function getWorker(createData: CreateData) {
  const worker = createWebWorker();
  worker.postMessage(createData);
  return worker;
}
