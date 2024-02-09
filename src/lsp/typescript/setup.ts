import type * as monacoNS from "monaco-editor-core";
import type ts from "typescript";
import { blankImportMap, isBlank } from "../../import-map";
import { ImportMap, parseImportMapFromJson } from "../../import-map";
import type { VFS } from "../../vfs";
import type { CreateData, Host, TypeScriptWorker } from "./worker";
import * as lf from "./language-features";

type TSWorker = monacoNS.editor.MonacoWebWorker<TypeScriptWorker>;

class EventTrigger {
  private _fireTimer = null;

  constructor(private _emitter: monacoNS.Emitter<void>) {}

  public get event() {
    return this._emitter.event;
  }

  public fire() {
    if (this._fireTimer !== null) {
      // already fired
      return;
    }
    this._fireTimer = setTimeout(() => {
      this._fireTimer = null;
      this._emitter.fire();
    }, 0) as any;
  }
}

/** Convert string to URL. */
function toUrl(name: string | URL) {
  return typeof name === "string" ? new URL(name, "file:///") : name;
}

/**
 * Parse JSONC.
 * @source: https://www.npmjs.com/package/tiny-jsonc
 */
const stringOrCommentRe = /("(?:\\?[^])*?")|(\/\/.*)|(\/\*[^]*?\*\/)/g;
const stringOrTrailingCommaRe = /("(?:\\?[^])*?")|(,\s*)(?=]|})/g;
function parseJsonc(text: string) {
  try {
    // Fast path for valid JSON
    return JSON.parse(text);
  } catch {
    // Slow path for JSONC and invalid inputs
    return JSON.parse(
      text.replace(stringOrCommentRe, "$1").replace(
        stringOrTrailingCommaRe,
        "$1",
      ),
    );
  }
}

/** Load compiler options from tsconfig.json in VFS if exists. */
async function loadCompilerOptions(vfs: VFS) {
  const compilerOptions: ts.CompilerOptions = {};
  try {
    const tconfigjson = await vfs.readTextFile("tsconfig.json");
    const tconfig = parseJsonc(tconfigjson);
    const types = tconfig.compilerOptions.types;
    delete tconfig.compilerOptions.types;
    Array.isArray(types) && await Promise.all(types.map(async (type) => {
      if (/^https?:\/\//.test(type)) {
        const res = await vfs.fetch(type);
        const dtsUrl = res.headers.get("x-typescript-types");
        if (dtsUrl) {
          res.body.cancel?.();
          const res2 = await vfs.fetch(dtsUrl);
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
      } else if (typeof type === "string") {
        const dtsUrl = toUrl(type.replace(/\.d\.ts$/, "") + ".d.ts");
        try {
          return [dtsUrl.href, await vfs.readTextFile(dtsUrl)];
        } catch (error) {
          console.error(
            `Failed to read "${dtsUrl.href}": ` + error.message,
          );
        }
      }
      return null;
    })).then((entries) => {
      compilerOptions.$types = entries.map(([url]) => url).filter((url) => url.startsWith("file://"));
      lf.libFiles.setExtraLibs(Object.fromEntries(entries.filter(Boolean)));
    });
    compilerOptions.$src = toUrl("tsconfig.json").href;
    Object.assign(compilerOptions, tconfig.compilerOptions);
  } catch (error) {
    if (error instanceof vfs.ErrorNotFound) {
      // ignore
    } else {
      console.error(error);
    }
  }
  return compilerOptions;
}

/** Load import maps from the root index.html or external json file. */
async function loadImportMap(vfs: VFS, postload: (im: ImportMap) => ImportMap) {
  try {
    const indexHtml = await vfs.readTextFile("index.html");
    const tplEl = document.createElement("template");
    tplEl.innerHTML = indexHtml;
    const scriptEl: HTMLScriptElement = tplEl.content.querySelector(
      'script[type="importmap"]',
    );
    if (scriptEl) {
      const im = parseImportMapFromJson(
        scriptEl.src ? await vfs.readTextFile(scriptEl.src) : scriptEl.textContent,
      );
      im.$src = toUrl(scriptEl.src ? scriptEl.src : "index.html").href;
      return postload(im);
    }
  } catch (error) {
    if (error instanceof vfs.ErrorNotFound) {
      // ignore
    } else {
      console.error(error);
    }
  }
  return blankImportMap();
}

/** Create the typescript worker. */
async function createWorker(
  monaco: typeof monacoNS,
  format?: Record<string, unknown>,
  vfs?: VFS,
) {
  const defaultCompilerOptions: ts.CompilerOptions = {
    allowImportingTsExtensions: true,
    allowJs: true,
    module: 99, // ModuleKind.ESNext,
    moduleResolution: 100, // ModuleResolutionKind.Bundler,
    target: 99, // ScriptTarget.ESNext,
    noEmit: true,
    ...Reflect.get(monaco.languages, "compilerOptions"),
  };
  const defaultImportMap = parseImportMapFromJson(
    Reflect.get(monaco.languages, "importMapJSON") ?? "{}",
  );
  const remixImportMap = (im: ImportMap): ImportMap => {
    if (isBlank(defaultImportMap)) {
      return im;
    }
    return {
      ...im,
      imports: Object.assign({}, defaultImportMap.imports, im.imports),
      scopes: Object.assign({}, defaultImportMap.scopes, im.scopes),
    };
  };

  // @ts-expect-error 'libs.js' is generated at build time
  const promises = [import("./libs.js").then((m) => m.default)];

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

  const [libs] = await Promise.all(promises);
  lf.libFiles.setLibs(libs);

  const createData: CreateData = {
    compilerOptions,
    libs,
    extraLibs: lf.libFiles.extraLibs,
    importMap,
    formatOptions: {
      tabSize: 4,
      trimTrailingWhitespace: true,
      ...format,
    },
  };
  const worker = monaco.editor.createWebWorker<TypeScriptWorker>({
    moduleId: "lsp/typescript/worker",
    label: "typescript",
    keepIdleModels: true,
    createData,
    host: {
      tryOpenModel: async (uri: string): Promise<boolean> => {
        if (!vfs) {
          return false; // vfs is not enabled
        }
        try {
          await vfs.openModel(uri);
        } catch (error) {
          if (error instanceof vfs.ErrorNotFound) {
            return false;
          }
        }
        return true; // model is opened or error is not NotFound
      },
      refreshDiagnostics: async () => {
        refreshDiagnosticEventEmitter?.fire();
      },
    } satisfies Host,
  });

  const updateCompilerOptions: TypeScriptWorker["updateCompilerOptions"] = async (options) => {
    const proxy = await worker.getProxy();
    await proxy.updateCompilerOptions(options);
    refreshDiagnosticEventEmitter?.fire();
  };

  if (vfs) {
    const watchTypes = () =>
      (compilerOptions.$types as string[] ?? []).map((url) =>
        vfs.watch(url, async (e) => {
          if (e.kind === "remove") {
            lf.libFiles.removeExtraLib(url);
          } else {
            const content = await vfs.readTextFile(url);
            lf.libFiles.addExtraLib(content, url);
          }
          updateCompilerOptions({ extraLibs: lf.libFiles.extraLibs });
        })
      );
    const watchImportMap = () => {
      const { $src } = importMap;
      if ($src && $src !== "file:///index.html") {
        return vfs.watch($src, async (e) => {
          if (e.kind === "remove") {
            importMap = { ...defaultImportMap };
          } else {
            const content = await vfs.readTextFile($src);
            const im = parseImportMapFromJson(content);
            importMap = im;
          }
          updateCompilerOptions({ importMap });
        });
      }
    };
    let disposes = watchTypes();
    let dispose = watchImportMap();
    vfs.watch("tsconfig.json", async (e) => {
      disposes.forEach((dispose) => dispose());
      loadCompilerOptions(vfs).then((options) => {
        const newOptions = { ...defaultCompilerOptions, ...options };
        if (JSON.stringify(newOptions) !== JSON.stringify(compilerOptions)) {
          compilerOptions = newOptions;
          updateCompilerOptions({
            compilerOptions,
            extraLibs: lf.libFiles.extraLibs,
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
        dispose = watchImportMap();
      });
    });
  }

  return worker;
}

// javascript and typescript share the same worker
let worker: TSWorker | Promise<TSWorker> | null = null;
let refreshDiagnosticEventEmitter: EventTrigger | null = null;

export async function setup(
  languageId: string,
  monaco: typeof monacoNS,
  format?: Record<string, unknown>,
  vfs?: VFS,
) {
  const languages = monaco.languages;

  if (!refreshDiagnosticEventEmitter) {
    refreshDiagnosticEventEmitter = new EventTrigger(new monaco.Emitter());
  }

  if (!worker) {
    worker = createWorker(monaco, format, vfs);
  }
  if (worker instanceof Promise) {
    worker = await worker;
  }

  const workerWithResources = (
    ...uris: monacoNS.Uri[]
  ): Promise<TypeScriptWorker> => {
    return (worker as TSWorker).withSyncedResources(uris);
  };

  // register language features
  lf.preclude(monaco);
  languages.registerCompletionItemProvider(
    languageId,
    new lf.SuggestAdapter(workerWithResources),
  );
  languages.registerSignatureHelpProvider(
    languageId,
    new lf.SignatureHelpAdapter(workerWithResources),
  );
  languages.registerHoverProvider(
    languageId,
    new lf.QuickInfoAdapter(workerWithResources),
  );
  languages.registerDocumentHighlightProvider(
    languageId,
    new lf.DocumentHighlightAdapter(workerWithResources),
  );
  languages.registerDefinitionProvider(
    languageId,
    new lf.DefinitionAdapter(workerWithResources),
  );
  languages.registerReferenceProvider(
    languageId,
    new lf.ReferenceAdapter(workerWithResources),
  );
  languages.registerDocumentSymbolProvider(
    languageId,
    new lf.OutlineAdapter(workerWithResources),
  );
  languages.registerRenameProvider(
    languageId,
    new lf.RenameAdapter(workerWithResources),
  );
  languages.registerDocumentRangeFormattingEditProvider(
    languageId,
    new lf.FormatAdapter(workerWithResources),
  );
  languages.registerOnTypeFormattingEditProvider(
    languageId,
    new lf.FormatOnTypeAdapter(workerWithResources),
  );
  languages.registerCodeActionProvider(
    languageId,
    new lf.CodeActionAdaptor(workerWithResources),
  );
  languages.registerInlayHintsProvider(
    languageId,
    new lf.InlayHintsAdapter(workerWithResources),
  );

  const diagnosticsOptions: lf.DiagnosticsOptions = {
    noSemanticValidation: languageId === "javascript",
    noSyntaxValidation: false,
    onlyVisible: false,
  };
  new lf.DiagnosticsAdapter(
    diagnosticsOptions,
    refreshDiagnosticEventEmitter.event,
    languageId,
    workerWithResources,
  );
}

export function workerUrl() {
  const m = workerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found");
  const url = new URL(m[1], import.meta.url);
  Reflect.set(url, "import", () => import("./worker.js")); // trick for bundlers
  return url;
}
