import type monacoNS from "monaco-editor-core";
import type { CreateData, HTMLWorker } from "./worker";

// ! external module, don't remove the `.js` extension
import * as lf from "../language-features.js";

export function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  format?: Record<string, unknown>,
) {
  // register monacoNS for language features module
  lf.prelude(monaco);

  const languages = monaco.languages;
  const createData: CreateData = {
    languageId,
    options: {
      data: {
        useDefaultDataProvider: true,
      },
      suggest: {},
      format: {
        tabSize: 4,
        insertSpaces: false,
        wrapLineLength: 120,
        unformatted:
          "default\": \"a, abbr, acronym, b, bdo, big, br, button, cite, code, dfn, em, i, img, input, kbd, label, map, object, q, samp, select, small, span, strong, sub, sup, textarea, tt, var",
        contentUnformatted: "pre",
        indentInnerHtml: false,
        preserveNewLines: true,
        indentHandlebars: false,
        endWithNewline: false,
        extraLiners: "head, body, /html",
        wrapAttributes: "auto",
        ...format,
      },
    },
  };
  const worker = monaco.editor.createWebWorker<HTMLWorker>({
    moduleId: "lsp/html/worker",
    label: languageId,
    createData,
  });
  const workerAccessor: lf.WorkerAccessor<HTMLWorker> = (
    ...uris: monacoNS.Uri[]
  ): Promise<HTMLWorker> => {
    return worker.withSyncedResources(uris);
  };

  languages.registerCompletionItemProvider(
    languageId,
    new lf.CompletionAdapter(workerAccessor, [".", ":", "<", "\"", "=", "/"]),
  );
  languages.registerHoverProvider(
    languageId,
    new lf.HoverAdapter(workerAccessor),
  );
  languages.registerDocumentHighlightProvider(
    languageId,
    new lf.DocumentHighlightAdapter(workerAccessor),
  );
  languages.registerLinkProvider(
    languageId,
    new lf.DocumentLinkAdapter(workerAccessor),
  );
  languages.registerFoldingRangeProvider(
    languageId,
    new lf.FoldingRangeAdapter(workerAccessor),
  );
  languages.registerDocumentSymbolProvider(
    languageId,
    new lf.DocumentSymbolAdapter(workerAccessor),
  );
  languages.registerSelectionRangeProvider(
    languageId,
    new lf.SelectionRangeAdapter(workerAccessor),
  );
  languages.registerRenameProvider(
    languageId,
    new lf.RenameAdapter(workerAccessor),
  );
  languages.registerDocumentFormattingEditProvider(
    languageId,
    new lf.DocumentFormattingEditProvider(workerAccessor),
  );
  languages.registerDocumentRangeFormattingEditProvider(
    languageId,
    new lf.DocumentRangeFormattingEditProvider(workerAccessor),
  );

  const codeLensEmitter = new monaco.Emitter<monacoNS.languages.CodeLensProvider>();
  languages.registerCodeLensProvider(languageId, {
    onDidChange: codeLensEmitter.event,
    resolveCodeLens: (model, codeLens, token) => {
      return codeLens;
    },
    provideCodeLenses: function(model, token) {
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
