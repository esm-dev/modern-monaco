import type monacoNS from "monaco-editor-core";
import { blankImportMap, type ImportMap, parseImportMapFromJson } from "./import-map";
import { createPersistTask, createProxy, decode, encode, openVFSiDB, toUrl, waitIDBRequest } from "./util";

interface VFile {
  url: string;
  version: number;
  content: string | Uint8Array;
  ctime: number;
  mtime: number;
}

interface VFSEvent {
  kind: "create" | "modify" | "remove";
  path: string;
  isModelChange?: boolean;
}

export interface VFSState {
  activeFile?: string;
}

interface VFSOptions {
  scope?: string;
  initial?: Record<string, string[] | string | Uint8Array>;
}

/** Virtual file system for monaco editor. */
export class VFS {
  private _db: Promise<IDBDatabase> | IDBDatabase;
  private _monaco: typeof monacoNS;
  private _state: VFSState = {};
  private _viewState: Record<string, monacoNS.editor.ICodeEditorViewState> = {};
  private _stateChangeHandlers = new Set<() => void>();
  private _watchHandlers = new Map<string, Set<(evt: VFSEvent) => void>>();

  constructor(options: VFSOptions) {
    const dbName = ["monaco-vfs", options.scope].filter(Boolean).join("/");
    const req = openVFSiDB(dbName, 1, (store) => {
      for (const [name, data] of Object.entries(options.initial ?? {})) {
        const url = toUrl(name);
        const now = Date.now();
        const item: VFile = {
          url: url.href,
          version: 1,
          content: Array.isArray(data) && !(data instanceof Uint8Array) ? data.join("\n") : data,
          ctime: now,
          mtime: now,
        };
        store.add(item);
      }
    });
    this._db = req.then(async (db) => this._db = db);
    if (globalThis.localStorage) {
      const state = {};
      const storeKey = ["monaco-state", options.scope].filter(Boolean).join("/");
      const persist = createPersistTask(() => {
        localStorage.setItem(storeKey, JSON.stringify(this._state));
      }, 100);
      const storeValue = localStorage.getItem(storeKey);
      if (storeValue) {
        try {
          Object.assign(state, JSON.parse(storeValue));
        } catch (e) {
          console.error(e);
        }
      }
      this._state = createProxy(state, () => {
        this._stateChangeHandlers.forEach((handler) => handler());
        persist();
      });
    }
  }

  get ErrorNotFound() {
    return ErrorNotFound;
  }

  get state() {
    return this._state;
  }

  get viewState() {
    return this._viewState;
  }

  private async _tx(readonly = false) {
    const db = await this._db;
    const storeKey = "files";
    return db.transaction(storeKey, readonly ? "readonly" : "readwrite").objectStore(storeKey);
  }

  async openModel(
    name: string | URL,
    attachTo?: monacoNS.editor.ICodeEditor | number | string | boolean,
    selectionOrPosition?: monacoNS.IRange | monacoNS.IPosition,
  ) {
    const monaco = this._monaco;
    if (!monaco) {
      throw new Error("monaco is undefined");
    }
    const url = toUrl(name);
    const href = url.href;
    const uri = monaco.Uri.parse(href);
    const { content, version } = await this._read(url);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(decode(content), undefined, uri);
    if (!Reflect.has(model, "__VFS__")) {
      const onDidChange = createPersistTask(() => {
        return this.writeFile(uri.toString(), model.getValue(), version + model.getVersionId(), true);
      }, 500);
      const disposable = model.onDidChangeContent(onDidChange);
      const unwatch = this.watch(href, async (evt) => {
        if (evt.kind === "modify" && !evt.isModelChange) {
          const { content } = await this._read(url);
          if (model.getValue() !== decode(content)) {
            model.setValue(decode(content));
            model.pushStackElement();
          }
        }
      });
      model.onWillDispose(() => {
        Reflect.deleteProperty(model, "__VFS__");
        disposable.dispose();
        unwatch();
      });
      Reflect.set(model, "__VFS__", true);
    }
    if (attachTo) {
      let editor: monacoNS.editor.ICodeEditor;
      if (attachTo === true) {
        editor = monaco.editor.getEditors()[0];
      } else if (typeof attachTo === "number") {
        editor = monaco.editor.getEditors()[attachTo];
      } else if (typeof attachTo === "string") {
        for (const e of monaco.editor.getEditors()) {
          const container = e.getContainerDomNode();
          if (
            container.id === attachTo.slice(1) || (
              container.parentElement?.tagName === "MONACO-EDITOR" &&
              container.parentElement.id === attachTo.slice(1)
            )
          ) {
            editor = e;
            break;
          }
        }
      } else if (typeof attachTo === "object" && attachTo !== null && typeof attachTo.setModel === "function") {
        editor = attachTo;
      }
      if (editor) {
        editor.setModel(model);
        if (selectionOrPosition) {
          if ("endLineNumber" in selectionOrPosition) {
            editor.setSelection(selectionOrPosition);
          } else {
            editor.setPosition(selectionOrPosition);
          }
        } else {
          this._viewState[href] && editor.restoreViewState(this._viewState[href]);
        }
        if (this._state.activeFile !== href) {
          this._state.activeFile = href;
        }
      }
    }
    return model;
  }

  async exists(name: string | URL): Promise<boolean> {
    const url = toUrl(name);
    const db = await this._tx(true);
    return waitIDBRequest<string>(db.getKey(url.href)).then((key) => key === url.href);
  }

  async list() {
    const db = await this._tx(true);
    const req = db.getAllKeys();
    return await waitIDBRequest<string[]>(req);
  }

  private async _read(name: string | URL) {
    const url = toUrl(name);
    const db = await this._tx(true);
    const ret = await waitIDBRequest<VFile | undefined>(db.get(url.href));
    if (!ret) {
      throw new ErrorNotFound(name);
    }
    return ret;
  }

  async readFile(name: string | URL) {
    const { content } = await this._read(name);
    return encode(content);
  }

  async readTextFile(name: string | URL) {
    const { content } = await this._read(name);
    return decode(content);
  }

  /** Load import maps from the root index.html or external json file. */
  async loadImportMap(verify?: (im: ImportMap) => ImportMap) {
    let src: string;
    try {
      const indexHtml = await this.readTextFile("index.html");
      const tplEl = document.createElement("template");
      tplEl.innerHTML = indexHtml;
      src = toUrl("index.html").href;
      const scriptEl: HTMLScriptElement = tplEl.content.querySelector(
        'script[type="importmap"]',
      );
      if (scriptEl) {
        if (scriptEl.src) {
          src = new URL(scriptEl.src, src).href;
        }
        const importMap = parseImportMapFromJson(
          scriptEl.src ? await this.readTextFile(scriptEl.src) : scriptEl.textContent,
        );
        importMap.$src = src;
        return verify?.(importMap) ?? importMap;
      }
    } catch (error) {
      // ignore error, fallback to a blank import map
      console.error(`Failed to read import map from "${src}":` + error.message);
    }
    const importMap = blankImportMap();
    importMap.$src = src;
    return verify?.(importMap) ?? importMap;
  }

  private async _write(url: string, content: string | Uint8Array, version?: number) {
    const db = await this._tx();
    const old = await waitIDBRequest<VFile | undefined>(db.get(url));
    const now = Date.now();
    const file: VFile = {
      url,
      version: version ?? (1 + (old?.version ?? 0)),
      content,
      ctime: old?.ctime ?? now,
      mtime: now,
    };
    await waitIDBRequest(db.put(file));
    return old ? "modify" : "create";
  }

  async writeFile(name: string | URL, content: string | Uint8Array, version?: number, isModelChange?: boolean) {
    const url = toUrl(name);
    const kind = await this._write(url.href, content, version);
    setTimeout(() => {
      for (const key of [url.href, "*"]) {
        const handlers = this._watchHandlers.get(key);
        if (handlers) {
          for (const handler of handlers) {
            handler({ kind, path: url.href, isModelChange });
          }
        }
      }
    }, 0);
  }

  async removeFile(name: string | URL): Promise<void> {
    const { pathname, href } = toUrl(name);
    const db = await this._tx();
    await waitIDBRequest(db.delete(href));
    setTimeout(() => {
      for (const key of [href, "*"]) {
        const handlers = this._watchHandlers.get(key);
        if (handlers) {
          for (const handler of handlers) {
            handler({ kind: "remove", path: pathname });
          }
        }
      }
    }, 0);
  }

  watch(name: string | URL, handler: (evt: VFSEvent) => void): () => void {
    const url = name == "*" ? name : toUrl(name).href;
    let handlers = this._watchHandlers.get(url);
    if (!handlers) {
      handlers = new Set();
      this._watchHandlers.set(url, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers!.delete(handler);
    };
  }

  useList(callback: (list: string[]) => void): () => void {
    const unwatch = this.watch("*", (evt) => {
      if (evt.kind === "create" || evt.kind === "remove") {
        this.list().then(callback);
      }
    });
    this.list().then(callback);
    return () => {
      unwatch();
    };
  }

  useState(callback: (state: VFSState) => void): () => void {
    const handler = () => callback(this._state);
    this._stateChangeHandlers.add(handler);
    handler();
    return () => {
      this._stateChangeHandlers.delete(handler);
    };
  }

  bindMonaco(monaco: typeof monacoNS) {
    monaco.editor.addCommand({
      id: "vfs.importmap.add_module",
      run: async (_: unknown, importMapSrc: string, specifier: string, uri: string) => {
        const model = monaco.editor.getModel(monaco.Uri.parse(importMapSrc));
        const { imports, scopes } = model && importMapSrc.endsWith(".json")
          ? parseImportMapFromJson(model.getValue())
          : await this.loadImportMap();
        imports[specifier] = uri;
        imports[specifier + "/"] = uri + "/";
        const json = JSON.stringify({ imports, scopes }, null, 2);
        if (importMapSrc.endsWith(".json")) {
          await this.writeFile(importMapSrc, model?.normalizeIndentation(json) ?? json);
        } else if (importMapSrc.endsWith(".html")) {
          const html = model?.getValue() ?? await this.readTextFile(importMapSrc);
          const newHtml = html.replace(
            /<script[^>]*?\s+type="importmap"\s*[^>]*>[^]*?<\/script>/,
            ['<script type="importmap">', ...json.split("\n").map((l) => "  " + l), "</script>"].join("\n  "),
          );
          await this.writeFile(importMapSrc, model?.normalizeIndentation(newHtml) ?? newHtml);
        }
      },
    });

    monaco.editor.registerEditorOpener({
      openCodeEditor: async (editor, resource, selectionOrPosition) => {
        try {
          await this.openModel(resource.toString(), editor, selectionOrPosition);
          return true;
        } catch (err) {
          if (err instanceof ErrorNotFound) {
            return false;
          }
          throw err;
        }
      },
    });

    this._monaco = monaco;
  }
}

/** Error for file not found. */
export class ErrorNotFound extends Error {
  constructor(name: string | URL) {
    super("file not found: " + name.toString());
  }
}

export { blankImportMap, parseImportMapFromJson };
