import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { Workspace } from "~/workspace.ts";
import type { CreateData, HTMLWorker } from "./worker.ts";

// ! external modules, don't remove the `.js` extension
import { walk } from "../../workspace.js";
import * as ls from "../language-service.js";

export async function setup(
  monaco: typeof monacoNS,
  languageId: string,
  workspace?: Workspace,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions,
) {
  const { editor, languages } = monaco;
  const { tabSize, insertSpaces, insertFinalNewline, trimFinalNewlines } = formattingOptions ?? {};
  const createData: CreateData = {
    suggest: {
      hideAutoCompleteProposals: languageSettings?.hideAutoCompleteProposals as boolean | undefined,
      attributeDefaultValue: languageSettings?.attributeDefaultValue as "empty" | "singlequotes" | "doublequotes" | undefined,
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
      useDefaultDataProvider: true,
      dataProviders: Array.isArray(languageSettings?.customTags)
        ? { custom: { version: 1.1, tags: languageSettings.customTags as any } }
        : undefined,
    },
    fs: workspace ? await walk(workspace.fs, "/") : undefined,
  };
  const htmlWorker = editor.createWebWorker<HTMLWorker>({
    moduleId: "lsp/html/worker",
    label: languageId,
    createData,
    host: ls.createHost(workspace),
  });
  const workerWithEmbeddedLanguages = ls.createWorkerWithEmbeddedLanguages(htmlWorker);

  // register language features
  ls.registerEmbedded(languageId, workerWithEmbeddedLanguages, ["css", "javascript", "importmap"]);
  ls.registerBasicFeatures(languageId, workerWithEmbeddedLanguages, ["<", "/", "=", '"'], workspace);
  ls.registerAutoComplete(languageId, workerWithEmbeddedLanguages, [">", "/", "="]);
  ls.registerColorPresentation(languageId, workerWithEmbeddedLanguages); // css color presentation
  ls.registerDocumentLinks(languageId, workerWithEmbeddedLanguages);

  // register code lens provider for import maps
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
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
