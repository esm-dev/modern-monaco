import type monacoNS from "monaco-editor-core";
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
  const { editor, languages, Uri } = monaco;
  const diagnosticsEmitter = new monaco.Emitter<void>();
  const codeLensEmitter = new monaco.Emitter<monacoNS.languages.CodeLensProvider>();
  const { tabSize, insertSpaces, insertFinalNewline, trimFinalNewlines } = formattingOptions ?? {};
  const createData: CreateData = {
    languageId,
    options: {
      data: {
        useDefaultDataProvider: true,
        dataProviders: Array.isArray(languageSettings?.customTags)
          ? { custom: { version: 1.1, tags: languageSettings.customTags as any } }
          : undefined,
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
  const embeddedLanguages = { javascript: "js", css: "css", importmap: "importmap" };
  const worker = editor.createWebWorker<HTMLWorker>({
    moduleId: "lsp/html/worker",
    label: languageId,
    createData,
    host: {
      // redirects lsp requests of embedded languages
      async redirectLSPRequest(rsl: string, method: string, uri: string, ...args: any[]) {
        // @ts-expect-error `workerProxies` is added by esm-monaco
        const { workerProxies } = MonacoEnvironment;
        const langaugeId = rsl === "importmap" ? "json" : rsl;
        const workerProxy = workerProxies[langaugeId];
        if (typeof workerProxy === "function") {
          const embeddedUri = Uri.parse(uri + ".__EMBEDDED__." + embeddedLanguages[rsl]);
          return workerProxy(embeddedUri).then(worker => worker[method]?.(embeddedUri.toString(), ...args));
        }
        if (!workerProxy) {
          workerProxies[langaugeId] = [() => {
            // refresh diagnostics
            diagnosticsEmitter.fire();
          }];
        }
      },
    },
  });
  const codeLensProvider: monacoNS.languages.CodeLensProvider = {
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
  };
  const workerProxy: lf.WorkerProxy<HTMLWorker> = (
    ...uris: monacoNS.Uri[]
  ): Promise<HTMLWorker> => {
    return worker.withSyncedResources(uris);
  };

  // @ts-expect-error `onWorker` is added by esm-monaco
  MonacoEnvironment.onWorker(languageId, workerProxy);

  // set monacoNS and register language features
  lf.setup(monaco);
  lf.registerDefault(languageId, workerProxy, [".", ":", "<", "\"", "=", "/"]);
  lf.attachEmbeddedLanguages(workerProxy, embeddedLanguages);
  languages.registerDocumentHighlightProvider(languageId, new lf.DocumentHighlightAdapter(workerProxy));
  languages.registerDefinitionProvider(languageId, new lf.DefinitionAdapter(workerProxy));
  languages.registerRenameProvider(languageId, new lf.RenameAdapter(workerProxy));
  languages.registerLinkProvider(languageId, new lf.DocumentLinkAdapter(workerProxy));
  languages.registerColorProvider(languageId, new lf.DocumentColorAdapter(workerProxy));
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
