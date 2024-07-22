import type monacoNS from "monaco-editor-core";
import type ts from "typescript";
import type { FormattingOptions } from "vscode-languageserver-types";
import type { ImportMap } from "~/import-map";
import type { VFS } from "~/vfs";
import type { CreateData, Host, TypeScriptWorker, VersionedContent } from "./worker";

// ! external modules, don't remove the `.js` extension
import { cache } from "../../cache.js";
import { createBlankImportMap, importMapFrom, isBlankImportMap, parseImportMapFromJson } from "../../import-map.js";
import * as ls from "../language-service.js";

type TSWorker = monacoNS.editor.MonacoWebWorker<TypeScriptWorker>;

// javascript and typescript share the same worker
let worker: TSWorker | Promise<TSWorker> | null = null;

export async function setup(
  monaco: typeof monacoNS,
  languageId: string,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions & { semicolon?: "ignore" | "insert" | "remove" },
  vfs?: VFS,
) {
  if (!worker) {
    worker = createWorker(monaco, languageSettings, formattingOptions, vfs);
  }
  if (worker instanceof Promise) {
    worker = await worker;
  }

  const languages = monaco.languages;
  const workerProxy = (...uris: monacoNS.Uri[]): Promise<TypeScriptWorker> => {
    return (worker as TSWorker).withSyncedResources(uris);
  };

  // @ts-expect-error `onWorker` is added by esm-monaco
  MonacoEnvironment.onWorker(languageId, workerProxy);

  // set monacoNS and register language features
  ls.setup(monaco);
  ls.enableDefaultFeatures(languageId, workerProxy, [".", "<", "/", "\"", "'"]);
  ls.enableAutoInsert(languageId, workerProxy, [">", "/"]);
  ls.enableSignatureHelp(languageId, workerProxy, ["(", ","]);
  ls.enableCodeAction(languageId, workerProxy);

  // unimplemented features
  // languages.registerOnTypeFormattingEditProvider(languageId, new lfs.FormatOnTypeAdapter(workerProxy));
  // languages.registerInlayHintsProvider(languageId, new lfs.InlayHintsAdapter(workerProxy));
  // languages.registerLinkedEditingRangeProvider(languageId, new lfs.LinkedEditingRangeAdapter(workerProxy));
}

export function getWorkerUrl() {
  const i = () => import("./worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}

/** Create the typescript worker. */
async function createWorker(
  monaco: typeof monacoNS,
  languageSettings?: Record<string, unknown>,
  formattingOptions?: FormattingOptions & { semicolon?: "ignore" | "insert" | "remove" },
  vfs?: VFS,
) {
  const defaultCompilerOptions: ts.CompilerOptions = {
    allowImportingTsExtensions: true,
    allowJs: true,
    module: 99, // ModuleKind.ESNext,
    moduleResolution: 100, // ModuleResolutionKind.Bundler,
    target: 99, // ScriptTarget.ESNext,
    noEmit: true,
    ...(languageSettings?.compilerOptions as ts.CompilerOptions),
  };
  const typesStore = new TypesStore();
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
  const promises = [
    // @ts-expect-error 'libs.js' is generated at build time
    import("./libs.js").then((m) => Object.assign(m.default, languageSettings?.extraLibs)),
  ];

  let compilerOptions: ts.CompilerOptions = { ...defaultCompilerOptions };
  let importMap = { ...defaultImportMap };

  if (vfs) {
    promises.push(
      loadCompilerOptions(vfs).then((options) => {
        compilerOptions = { ...defaultCompilerOptions, ...options };
      }),
      loadImportMap(vfs, remixImportMap).then((im) => {
        importMap = im;
      }),
    );
  }

  // wait for all promises to resolve
  const [libs] = await Promise.all(promises);

  // resolve types of the default compiler options
  await typesStore.load(compilerOptions, vfs);

  const { tabSize = 4, trimTrailingWhitespace = true, insertSpaces = true, semicolon = "insert" } = formattingOptions ?? {};
  const createData: CreateData = {
    compilerOptions,
    importMap,
    libs,
    types: typesStore.types,
    hasVFS: Boolean(vfs),
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
  };
  const refreshDiagnostics = async () => ls.refreshDiagnostics("javascript", "typescript", "jsx", "tsx");
  const worker = monaco.editor.createWebWorker<TypeScriptWorker>({
    moduleId: "lsp/typescript/worker",
    label: "typescript",
    keepIdleModels: true,
    createData,
    host: {
      openModel: async (uri: string): Promise<boolean> => {
        if (!vfs) {
          throw new Error("VFS is not available");
        }
        try {
          await vfs.openModel(uri);
        } catch (error) {
          if (error instanceof vfs.ErrorNotFound) {
            return false;
          }
          throw error;
        }
        return true; // model is opened or error is not NotFound
      },
      refreshDiagnostics,
    } satisfies Host,
  });

  if (vfs) {
    const updateCompilerOptions: TypeScriptWorker["updateCompilerOptions"] = async (options) => {
      const proxy = await worker.getProxy();
      await proxy.updateCompilerOptions(options);
      refreshDiagnostics();
    };
    const watchTypes = () =>
      (compilerOptions.$types as string[] ?? []).map((url) =>
        vfs.watch(url, async (e) => {
          if (e.kind === "remove") {
            typesStore.remove(url);
          } else {
            const content = await vfs.readTextFile(url);
            typesStore.add(content, url);
          }
          updateCompilerOptions({ types: typesStore.types });
        })
      );
    const watchImportMapJSON = () => {
      const { $src } = importMap;
      if ($src && $src.endsWith(".json")) {
        return vfs.watch($src, async (e) => {
          if (e.kind === "remove") {
            importMap = { ...defaultImportMap };
          } else {
            try {
              const content = await vfs.readTextFile($src);
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
    let disposes = watchTypes();
    let dispose = watchImportMapJSON();

    vfs.watch("tsconfig.json", async (e) => {
      disposes.forEach((dispose) => dispose());
      loadCompilerOptions(vfs).then((options) => {
        const newOptions = { ...defaultCompilerOptions, ...options };
        if (JSON.stringify(newOptions) !== JSON.stringify(compilerOptions)) {
          compilerOptions = newOptions;
          typesStore.load(compilerOptions, vfs).then(() => {
            updateCompilerOptions({ compilerOptions, types: typesStore.types });
          });
        }
        disposes = watchTypes();
      });
    });

    vfs.watch("index.html", async (e) => {
      dispose?.();
      loadImportMap(vfs, remixImportMap).then((im) => {
        if (JSON.stringify(im) !== JSON.stringify(importMap)) {
          importMap = im;
          updateCompilerOptions({ importMap });
        }
        dispose = watchImportMapJSON();
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

class TypesStore {
  private _types: Record<string, VersionedContent> = {};
  private _removedtypes: Record<string, number> = {};

  get types() {
    return this._types;
  }

  public setTypes(types: Record<string, string>) {
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
  async load(compilerOptions: ts.CompilerOptions, vfs?: VFS) {
    const types = compilerOptions.types;
    if (Array.isArray(types)) {
      delete compilerOptions.types;
      await Promise.all(types.map(async (type) => {
        if (/^https?:\/\//.test(type)) {
          const res = await cache.fetch(type);
          const dtsUrl = res.headers.get("x-typescript-types");
          if (dtsUrl) {
            res.body.cancel?.();
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
        } else if (typeof type === "string" && vfs) {
          const dtsUrl = new URL(type.replace(/\.d\.ts$/, "") + ".d.ts", "file:///");
          try {
            return [dtsUrl.href, await vfs.readTextFile(dtsUrl)];
          } catch (error) {
            console.error(`Failed to read "${dtsUrl.href}": ` + error.message);
          }
        }
        return null;
      })).then((entries) => {
        if (vfs) {
          compilerOptions.$types = entries.map(([url]) => url).filter((url) => url.startsWith("file://"));
        }
        this.setTypes(Object.fromEntries(entries.filter(Boolean)));
      });
    }
  }
}

/** Load compiler options from tsconfig.json in VFS if exists. */
async function loadCompilerOptions(vfs: VFS) {
  const compilerOptions: ts.CompilerOptions = {};
  try {
    const tsconfigjson = await vfs.readTextFile("tsconfig.json");
    const tsconfig = parseJsonc(tsconfigjson);
    compilerOptions.$src = "file:///tsconfig.json";
    Object.assign(compilerOptions, tsconfig.compilerOptions);
  } catch (error) {
    if (error instanceof vfs.ErrorNotFound) {
      // ignore
    } else {
      console.error(error);
    }
  }
  return compilerOptions;
}

/** Load import maps from the root index.html or external json file in the VFS. */
export async function loadImportMap(vfs: VFS, validate: (im: ImportMap) => ImportMap) {
  let src: string;
  try {
    const indexHtml = await vfs.readTextFile("index.html");
    const tplEl = document.createElement("template");
    tplEl.innerHTML = indexHtml;
    const scriptEl: HTMLScriptElement = tplEl.content.querySelector("script[type=\"importmap\"]");
    if (scriptEl) {
      src = "file:///index.html";
      if (scriptEl.src) {
        src = new URL(scriptEl.src, src).href;
      }
      const importMap = parseImportMapFromJson(
        scriptEl.src ? await vfs.readTextFile(scriptEl.src) : scriptEl.textContent,
      );
      importMap.$src = src;
      return validate(importMap);
    }
  } catch (error) {
    // ignore error, fallback to a blank import map
    console.error(`Failed to load import map from "${src}":`, error.message);
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
