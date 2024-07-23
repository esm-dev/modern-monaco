import type monacoNS from "monaco-editor-core";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { VFS } from "~/vfs.ts";
import type { CreateData, CSSWorker } from "./worker.ts";

// ! external modules, don't remove the `.js` extension
import * as ls from "../language-service.js";

export function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions,
  vfs?: VFS,
) {
  const { tabSize, insertSpaces, insertFinalNewline, trimFinalNewlines } = formattingOptions ?? {};
  const createData: CreateData = {
    language: languageId as "css" | "less" | "scss",
    data: {
      useDefaultDataProvider: true,
      // todo: custom data provider
    },
    format: {
      tabSize,
      insertFinalNewline,
      insertSpaces,
      preserveNewLines: !trimFinalNewlines,
      newlineBetweenSelectors: true,
      newlineBetweenRules: true,
      spaceAroundSelectorSeparator: false,
      braceStyle: "collapse",
    },
    hasVFS: !!vfs,
  };
  const worker = monaco.editor.createWebWorker<CSSWorker>({
    moduleId: "lsp/css/worker",
    label: languageId,
    createData,
    host: {
      readDirectory: async (uri: string) => {
        const entries = [];
        const dirs = new Set<string>();
        for (const path of await vfs.ls()) {
          if (path.startsWith(uri) && (path.endsWith("." + languageId) || path.endsWith(".css"))) {
            const name = path.slice(uri.length);
            if (name.includes("/")) {
              const [dirName] = name.split("/");
              if (!dirs.has(dirName)) {
                dirs.add(dirName);
                entries.push([dirName, 2]);
              }
            } else {
              entries.push([name, 1]);
            }
          }
        }
        return entries;
      },
      stat: async (uri: string) => {
        const file = await vfs.open(uri);
        return {
          type: 1,
          ctime: file.ctime,
          mtime: file.mtime,
          size: file.content.length,
        };
      },
      getContent: async (uri: string, encoding?: string): Promise<string> => {
        return vfs.readTextFile(uri);
      },
    },
  });

  // set monacoNS and register language features
  ls.setup(monaco);
  ls.enableBasicFeatures(languageId, worker, ["/", "-", ":", "("]);
  ls.enableCodeAction(languageId, worker);
  ls.enableColorPresentation(languageId, worker);
  ls.enableDocumentLinks(languageId, worker);
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}
