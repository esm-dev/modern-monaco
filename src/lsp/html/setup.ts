import monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { CreateData, HTMLWorker } from "./worker";

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
  const { tabSize, insertSpaces, insertFinalNewline, trimFinalNewlines } = formattingOptions ?? {};
  const createData: CreateData = {
    languageId,
    options: {
      data: {
        useDefaultDataProvider: true,
      },
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
  };
  const worker = editor.createWebWorker<HTMLWorker>({
    moduleId: "lsp/html/worker",
    label: languageId,
    createData,
    host: {
      // redirects lsp requests of embedded languages
      async redirectLSPRequest(embeddedLanguageId: string, method: string, uri: string, ...args: any[]) {
        if (embeddedLanguageId === "importmap") {
          embeddedLanguageId = "json";
        }
        // @ts-expect-error `onWorker` is added by esm-monaco
        const { workerProxies } = MonacoEnvironment;
        const worker = workerProxies[embeddedLanguageId];
        if (typeof worker === "function") {
          return worker(uri).then(worker => worker[method](uri, ...args));
        }
        if (!worker) {
          workerProxies[embeddedLanguageId] = [() => {
            // refresh diagnostics
            diagnosticsEmitter.fire();
          }];
        }
      },
    },
  });
  const workerAccessor: lf.WorkerAccessor<HTMLWorker> = (
    ...uris: monacoNS.Uri[]
  ): Promise<HTMLWorker> => {
    return worker.withSyncedResources(uris);
  };

  // @ts-expect-error `onWorker` is added by esm-monaco
  MonacoEnvironment.onWorker(languageId, workerAccessor);

  // set monacoNS and register default language features
  lf.setup(monaco);
  lf.registerDefault(languageId, workerAccessor, [".", ":", "<", "\"", "=", "/"]);

  // attach embedded languages in memory
  lf.attachEmbeddedLanguages(workerAccessor, ["css", "importmap"]);

  // register diagnostics adapter (for embedded languages)
  new lf.DiagnosticsAdapter(languageId, workerAccessor, diagnosticsEmitter.event);

  // register language features
  languages.registerColorProvider(languageId, new lf.DocumentColorAdapter(workerAccessor));
  languages.registerDocumentHighlightProvider(languageId, new lf.DocumentHighlightAdapter(workerAccessor));
  languages.registerLinkProvider(languageId, new lf.DocumentLinkAdapter(workerAccessor));
  languages.registerRenameProvider(languageId, new lf.RenameAdapter(workerAccessor));

  // code lens for importmap updating
  languages.registerCodeLensProvider(languageId, {
    onDidChange: codeLensEmitter.event,
    resolveCodeLens: (_model, codeLens, _token) => {
      return codeLens;
    },
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
  });
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
