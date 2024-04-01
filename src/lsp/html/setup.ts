import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { CreateData, HTMLWorker } from "./worker";
import * as lfs from "../language-features.js";

export function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions,
) {
  const { editor, languages } = monaco;
  const { tabSize, insertSpaces, insertFinalNewline, trimFinalNewlines } = formattingOptions ?? {};
  const createData: CreateData = {
    settings: {
      suggest: {},
      format: {
        tabSize,
        insertSpaces,
        endWithNewline: insertFinalNewline,
        preserveNewLines: !trimFinalNewlines,
        maxPreserveNewLines: 1,
        indentInnerHtml: false,
        indentHandlebars: false,
        unformatted:
          "default\": \"a, abbr, acronym, b, bdo, big, br, button, cite, code, dfn, em, i, img, input, kbd, label, map, object, q, samp, select, small, span, strong, sub, sup, textarea, tt, var",
        contentUnformatted: "pre",
        // extraLiners: "head, body, /html",
        extraLiners: "",
        wrapAttributes: "auto",
      },
    },
    data: {
      useDefaultDataProvider: true,
      dataProviders: Array.isArray(languageSettings?.customTags)
        ? { custom: { version: 1.1, tags: languageSettings.customTags as any } }
        : undefined,
    },
  };
  const embeddedLanguages = { javascript: "js", css: "css", importmap: "importmap" };
  const htmlWorker = editor.createWebWorker<HTMLWorker>({
    moduleId: "lsp/html/worker",
    label: languageId,
    createData,
  });
  const codeLensProvider: monacoNS.languages.CodeLensProvider = {
    provideCodeLenses: (model, _token) => {
      const m = model.findNextMatch(
        `type=['"]importmap['"]`,
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
  const htmlWorkerProxy: lfs.WorkerProxy<HTMLWorker> = (...uris) => htmlWorker.withSyncedResources(uris);
  const workerProxy = lfs.proxyWorkerWithEmbeddedLanguages(embeddedLanguages, htmlWorkerProxy);

  // @ts-expect-error `onWorker` is added by esm-monaco
  MonacoEnvironment.onWorker(languageId, htmlWorkerProxy);

  // set monacoNS and register language features
  lfs.setup(monaco);
  lfs.attachEmbeddedLanguages(languageId, embeddedLanguages, htmlWorkerProxy);
  lfs.registerDefault(languageId, workerProxy, [".", ":", "<", "\"", "=", "/"]);
  languages.registerDocumentHighlightProvider(languageId, new lfs.DocumentHighlightAdapter(workerProxy));
  languages.registerDefinitionProvider(languageId, new lfs.DefinitionAdapter(workerProxy));
  languages.registerRenameProvider(languageId, new lfs.RenameAdapter(workerProxy));
  languages.registerLinkProvider(languageId, new lfs.DocumentLinkAdapter(workerProxy));
  languages.registerColorProvider(languageId, new lfs.DocumentColorAdapter(workerProxy));
  languages.registerCodeLensProvider(languageId, codeLensProvider);
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
