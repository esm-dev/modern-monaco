import type monacoNS from "monaco-editor-core";
import type ts from "typescript";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { Workspace } from "~/workspace";
import type { CreateData, Host, TypeScriptWorker, VersionedContent } from "./worker";
import {
  createBlankImportMap,
  type ImportMap,
  importMapFrom,
  isBlankImportMap,
  isSameImportMap,
  parseImportMapFromJson,
} from "@esm.sh/import-map";

// ! external modules, don't remove the `.js` extension
import { cache } from "../../cache.js";
import { ErrorNotFound } from "../../workspace.js";
import * as ls from "../language-service.js";

type TSWorker = monacoNS.editor.MonacoWebWorker<TypeScriptWorker>;
type CompilerOptions = { [key: string]: ts.CompilerOptionsValue };

// javascript and typescript share the same worker
let worker: TSWorker | Promise<TSWorker> | null = null;

export async function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions & { semicolon?: "ignore" | "insert" | "remove" },
  workspace?: Workspace,
) {
  if (!worker) {
    worker = createWorker(monaco, workspace, languageSettings, formattingOptions);
  }
  if (worker instanceof Promise) {
    worker = await worker;
  }

  // register language features
  ls.registerBasicFeatures(languageId, worker, [".", "/", '"', "'", "<"], workspace);
  ls.registerAutoComplete(languageId, worker, [">", "/"]);
  ls.registerSignatureHelp(languageId, worker, ["(", ","]);
  ls.registerCodeAction(languageId, worker);

  // unimplemented features
  // languages.registerOnTypeFormattingEditProvider(languageId, new lfs.FormatOnTypeAdapter(worker));
  // languages.registerInlayHintsProvider(languageId, new lfs.InlayHintsAdapter(worker));
  // languages.registerLinkedEditingRangeProvider(languageId, new lfs.LinkedEditingRangeAdapter(worker));
}

/** Create the typescript worker. */
async function createWorker(
  monaco: typeof monacoNS,
  workspace?: Workspace,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions & { semicolon?: "ignore" | "insert" | "remove" },
) {
  const fs = workspace?.fs;
  const defaultCompilerOptions: CompilerOptions = {
    // set allowJs to true to support embedded javascript in html
    allowJs: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    isolatedModules: true,
    module: "esnext",
    moduleResolution: "bundler",
    moduleDetection: "force",
    skipLibCheck: true,
    target: "esnext",
    useDefineForClassFields: true,
    ...(languageSettings?.compilerOptions as CompilerOptions),
  };
  const typesStore = new TypesSet();
  const defaultImportMap = importMapFrom(languageSettings?.importMap);
  const remixImportMap = (im: ImportMap): ImportMap => {
    if (isBlankImportMap(defaultImportMap)) {
      return im;
    }
    return {
      ...im,
      imports: Object.assign({}, defaultImportMap.imports, im.imports),
      scopes: Object.assign({}, defaultImportMap.scopes, im.scopes),
    };
  };

  let compilerOptions: CompilerOptions = { ...defaultCompilerOptions };
  let importMap = { ...defaultImportMap };

  if (workspace) {
    await Promise.all([
      loadCompilerOptions(workspace).then((options) => {
        compilerOptions = { ...defaultCompilerOptions, ...options };
      }),
      loadImportMap(workspace, remixImportMap).then((im) => {
        importMap = im;
      }),
    ]);
  }

  // resolve types of the default compiler options
  await typesStore.load(compilerOptions, workspace);

  const { tabSize = 4, trimTrailingWhitespace = true, insertSpaces = true, semicolon = "insert" } = formattingOptions ?? {};
  const createData: CreateData = {
    compilerOptions,
    formatOptions: {
      tabSize,
      trimTrailingWhitespace,
      semicolons: semicolon as ts.SemicolonPreference,
      indentSize: tabSize,
      convertTabsToSpaces: insertSpaces,
      insertSpaceAfterCommaDelimiter: insertSpaces,
      insertSpaceAfterSemicolonInForStatements: insertSpaces,
      insertSpaceBeforeAndAfterBinaryOperators: insertSpaces,
      insertSpaceAfterKeywordsInControlFlowStatements: insertSpaces,
      insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: insertSpaces,
    },
    importMap,
    types: typesStore.types,
    workspace: !!workspace,
  };
  const worker = monaco.editor.createWebWorker<TypeScriptWorker>({
    worker: getWorker(createData),
    keepIdleModels: true,
    host: {
      openModel: async (uri: string): Promise<boolean> => {
        if (!workspace) {
          throw new Error("Workspace is undefined.");
        }
        try {
          await workspace._openTextDocument(uri);
        } catch (error) {
          if (error instanceof ErrorNotFound) {
            return false;
          }
          throw error;
        }
        return true;
      },
      refreshDiagnostics: async (uri: string) => {
        let model = monaco.editor.getModel(uri);
        if (model && model.uri.path.includes(".(embedded).")) {
          model = monaco.editor.getModel(model.uri.toString(true).split(".(embedded).")[0]);
        }
        if (model) {
          Reflect.get(model, "refreshDiagnostics")?.();
        }
      },
    } satisfies Host,
  });

  if (fs) {
    const updateCompilerOptions: TypeScriptWorker["updateCompilerOptions"] = async (options) => {
      const proxy = await worker.getProxy();
      await proxy.updateCompilerOptions(options);
      monaco.editor.getModels().forEach((model) => {
        const langaugeId = model.getLanguageId();
        if (langaugeId === "typescript" || langaugeId === "javascript" || langaugeId === "jsx" || langaugeId === "tsx") {
          Reflect.get(model, "refreshDiagnostics")?.();
        }
      });
    };
    const watchTypes = () =>
      (compilerOptions.$types as string[] ?? []).map((url) =>
        fs.watch(url, async (kind) => {
          if (kind === "remove") {
            typesStore.remove(url);
          } else {
            const content = await fs.readTextFile(url);
            typesStore.add(content, url);
          }
          updateCompilerOptions({ types: typesStore.types });
        })
      );
    const watchImportMapJSON = () => {
      const { $src } = importMap;
      if ($src && $src.endsWith(".json")) {
        return fs.watch($src, async (kind) => {
          if (kind === "remove") {
            importMap = { ...defaultImportMap };
          } else {
            try {
              const content = await fs.readTextFile($src);
              const im = parseImportMapFromJson(content);
              im.$src = $src;
              importMap = remixImportMap(im);
            } catch (error) {
              console.error("Failed to parse import map:", error);
              importMap = { ...defaultImportMap };
            }
          }
          updateCompilerOptions({ importMap });
        });
      }
    };
    let unwatchTypes = watchTypes();
    let unwatchImportMap = watchImportMapJSON();

    fs.watch("tsconfig.json", () => {
      unwatchTypes.forEach((dispose) => dispose());
      loadCompilerOptions(workspace).then((options) => {
        const newOptions = { ...defaultCompilerOptions, ...options };
        if (JSON.stringify(newOptions) !== JSON.stringify(compilerOptions)) {
          compilerOptions = newOptions;
          typesStore.load(compilerOptions, workspace).then(() => {
            updateCompilerOptions({ compilerOptions, types: typesStore.types });
          });
        }
        unwatchTypes = watchTypes();
      });
    });

    fs.watch("index.html", () => {
      unwatchImportMap?.();
      loadImportMap(workspace, remixImportMap).then((im) => {
        if (!isSameImportMap(importMap, im)) {
          importMap = im;
          updateCompilerOptions({ importMap });
        }
        unwatchImportMap = watchImportMapJSON();
      });
    });
  }

  monaco.editor.addCommand({
    id: "ts:fetch_http_module",
    run: async (_: unknown, url: string, containingFile: string) => {
      const proxy = await worker.getProxy();
      await proxy.fetchHttpModule(url, containingFile);
    },
  });

  return worker;
}

function createWebWorker(): Worker {
  const workerUrl: URL = new URL("./worker.mjs", import.meta.url);
  // create a blob url for cross-origin workers if the url is not same-origin
  if (workerUrl.origin !== location.origin) {
    return new Worker(
      URL.createObjectURL(new Blob([`import "${workerUrl.href}"`], { type: "application/javascript" })),
      { type: "module", name: "typescript-worker" },
    );
  }
  return new Worker(workerUrl, { type: "module", name: "typescript-worker" });
}

function getWorker(createData: CreateData) {
  const worker = createWebWorker();
  worker.postMessage(createData);
  return worker;
}

class TypesSet {
  private _types: Record<string, VersionedContent> = {};
  private _removedtypes: Record<string, number> = {};

  get types() {
    return this._types;
  }

  public reset(types: Record<string, string>) {
    const toRemove = Object.keys(this._types).filter(
      (key) => !types[key],
    );
    for (const key of toRemove) {
      this.remove(key);
    }
    for (const [filePath, content] of Object.entries(types)) {
      this.add(content, filePath);
    }
  }

  public add(content: string, filePath: string): boolean {
    if (
      this._types[filePath]
      && this._types[filePath].content === content
    ) {
      return false;
    }
    let version = 1;
    if (this._removedtypes[filePath]) {
      version = this._removedtypes[filePath] + 1;
    }
    if (this._types[filePath]) {
      version = this._types[filePath].version + 1;
    }
    this._types[filePath] = { content, version };
    return true;
  }

  public remove(filePath: string): boolean {
    const lib = this._types[filePath];
    if (lib) {
      delete this._types[filePath];
      this._removedtypes[filePath] = lib.version;
      return true;
    }
    return false;
  }

  /** load types defined in tsconfig.json */
  async load(compilerOptions: CompilerOptions, workspace?: Workspace): Promise<void> {
    const types = compilerOptions.types;
    if (Array.isArray(types)) {
      delete compilerOptions.types;
      await Promise.all(types.map(async (type) => {
        if (/^https?:\/\//.test(type)) {
          const res = await cache.fetch(type);
          const dtsUrl = res.headers.get("x-typescript-types");
          if (dtsUrl) {
            res.body?.cancel?.();
            const res2 = await cache.fetch(dtsUrl);
            if (res2.ok) {
              return [dtsUrl, await res2.text()];
            } else {
              console.error(
                `Failed to fetch "${dtsUrl}": ` + await res2.text(),
              );
            }
          } else if (res.ok) {
            return [type, await res.text()];
          } else {
            console.error(
              `Failed to fetch "${dtsUrl}": ` + await res.text(),
            );
          }
        } else if (typeof type === "string" && workspace) {
          const dtsUrl = new URL(type.replace(/\.d\.ts$/, "") + ".d.ts", "file:///").href;
          try {
            return [dtsUrl, await workspace.fs.readTextFile(dtsUrl)];
          } catch (error) {
            console.error(`Failed to read "${dtsUrl}": ` + error.message);
          }
        }
        return null;
      })).then((e) => {
        const entries = e.filter(Boolean) as [string, string][];
        if (workspace) {
          compilerOptions.$types = entries.map(([url]) => url).filter((url) => url.startsWith("file://"));
        }
        this.reset(Object.fromEntries(entries));
      });
    }
  }
}

/** Load compiler options from `tsconfig.json` in the workspace if exists. */
async function loadCompilerOptions(workspace: Workspace) {
  const compilerOptions: CompilerOptions = {};
  try {
    const tsconfigJson = await workspace.fs.readTextFile("tsconfig.json");
    const tsconfig = parseJsonc(tsconfigJson);
    compilerOptions.$src = "file:///tsconfig.json";
    Object.assign(compilerOptions, tsconfig.compilerOptions);
  } catch (error) {
    if (error instanceof ErrorNotFound) {
      // ignore
    } else {
      console.error(error);
    }
  }
  return compilerOptions;
}

/** Load import maps from the root index.html or external json file in the workspace. */
export async function loadImportMap(workspace: Workspace, validate: (im: ImportMap) => ImportMap) {
  let src: string | undefined;
  try {
    let indexHtml = await workspace.fs.readTextFile("index.html");
    let tplEl = document.createElement("template");
    let scriptEl: HTMLScriptElement | null;
    tplEl.innerHTML = indexHtml;
    scriptEl = tplEl.content.querySelector('script[type="importmap"]');
    if (scriptEl) {
      src = scriptEl.src ? new URL(scriptEl.src, "file:///").href : "file:///index.html";
      const importMap = parseImportMapFromJson(scriptEl.src ? await workspace.fs.readTextFile(scriptEl.src) : scriptEl.textContent!);
      importMap.$src = src;
      return validate(importMap);
    }
  } catch (error) {
    if (error instanceof ErrorNotFound) {
      // ignore
    } else {
      console.error("Failed to parse import map from index.html:", error.message);
    }
  }
  const importMap = createBlankImportMap();
  return validate(importMap);
}

/**
 * Parse JSONC.
 * @source: https://www.npmjs.com/package/tiny-jsonc
 */
function parseJsonc(text: string) {
  try {
    // Fast path for valid JSON
    return JSON.parse(text);
  } catch {
    // Slow path for JSONC and invalid inputs
    const stringOrCommentRe = /("(?:\\?[^])*?")|(\/\/.*)|(\/\*[^]*?\*\/)/g;
    const stringOrTrailingCommaRe = /("(?:\\?[^])*?")|(,\s*)(?=]|})/g;
    const fixed = text.replace(stringOrCommentRe, "$1").replace(stringOrTrailingCommaRe, "$1");
    return JSON.parse(fixed);
  }
}
