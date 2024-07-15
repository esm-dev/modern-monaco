import type monacoNS from "monaco-editor-core";

// ! external modules, don't remove the `.js` extension
import { loadImportMapFromVFS, parseImportMapFromJson } from "./import-map.js";
import { createPersistTask, createProxy, decode, encode, promisifyIDBRequest, toUrl } from "./util.js";

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

  static dbStoreName = "files";
  static openIDB(
    name: string,
    version?: number,
    onStoreCreate?: (store: IDBObjectStore) => void,
  ) {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VFS.dbStoreName)) {
        const store = db.createObjectStore(VFS.dbStoreName, { keyPath: "url" });
        onStoreCreate?.(store);
      }
    };
    return promisifyIDBRequest<IDBDatabase>(req);
  }

  constructor(options: VFSOptions) {
    this._db = this._openDB(options);
    if (globalThis.localStorage) {
      const state = {};
      const storeKey = ["monaco:state", options.scope].filter(Boolean).join(".");
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

  private _openDB(options: VFSOptions): Promise<IDBDatabase> {
    const dbName = ["monaco-vfs", options.scope].filter(Boolean).join("/");
    return VFS.openIDB(dbName, 1, (store) => {
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
    }).then((db) => {
      // reopen db on close
      db.onclose = () => {
        this._db = this._openDB(options);
      };
      return this._db = db;
    });
  }

  private async _tx(readonly = false) {
    return (await this._db).transaction(VFS.dbStoreName, readonly ? "readonly" : "readwrite").objectStore(VFS.dbStoreName);
  }

  async openModel(
    name: string | URL,
    attachTo?: monacoNS.editor.ICodeEditor | number | string | boolean,
    selectionOrPosition?: monacoNS.IRange | monacoNS.IPosition,
  ): Promise<monacoNS.editor.ITextModel> {
    const monaco = this._monaco;
    if (!monaco) {
      throw new Error("monaco is undefined");
    }
    const url = toUrl(name);
    const href = url.href;
    const uri = monaco.Uri.parse(href);
    const { content, version } = await this.open(url);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(decode(content), undefined, uri);
    if (!Reflect.has(model, "__VFS__")) {
      const onDidChange = createPersistTask(() => {
        return this.writeFile(uri.toString(), model.getValue(), version + model.getVersionId(), true);
      }, 500);
      const disposable = model.onDidChangeContent(onDidChange);
      const unwatch = this.watch(href, async (evt) => {
        if (evt.kind === "modify" && !evt.isModelChange) {
          const { content } = await this.open(url);
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
              container.parentElement?.tagName === "MONACO-EDITOR"
              && container.parentElement.id === attachTo.slice(1)
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
        editor.updateOptions({ readOnly: false });
        if (selectionOrPosition) {
          if ("startLineNumber" in selectionOrPosition) {
            editor.setSelection(selectionOrPosition);
          } else {
            editor.setPosition(selectionOrPosition);
          }
          const pos = editor.getPosition();
          editor.setScrollTop(
            editor.getScrolledVisiblePosition(new monaco.Position(pos.lineNumber - 7, pos.column)).top,
          );
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
    return promisifyIDBRequest<string>(db.getKey(url.href)).then((key) => key === url.href);
  }

  async ls(): Promise<string[]> {
    const db = await this._tx(true);
    return await promisifyIDBRequest<string[]>(db.getAllKeys());
  }

  async open(name: string | URL): Promise<VFile> {
    const url = toUrl(name);
    const db = await this._tx(true);
    const ret = await promisifyIDBRequest<VFile | undefined>(db.get(url.href));
    if (!ret) {
      throw new ErrorNotFound(name);
    }
    return ret;
  }

  async readFile(name: string | URL): Promise<Uint8Array> {
    const { content } = await this.open(name);
    return encode(content);
  }

  async readTextFile(name: string | URL): Promise<string> {
    const { content } = await this.open(name);
    return decode(content);
  }

  private async _write(url: string, content: string | Uint8Array, version?: number): Promise<"create" | "modify"> {
    const db = await this._tx();
    const old = await promisifyIDBRequest<VFile | undefined>(db.get(url));
    const now = Date.now();
    const file: VFile = {
      url,
      version: version ?? (1 + (old?.version ?? 0)),
      content,
      ctime: old?.ctime ?? now,
      mtime: now,
    };
    await promisifyIDBRequest(db.put(file));
    return old ? "modify" : "create";
  }

  async writeFile(name: string | URL, content: string | Uint8Array, version?: number, isModelChange?: boolean): Promise<void> {
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

  async remove(name: string | URL): Promise<void> {
    const { pathname, href } = toUrl(name);
    const db = await this._tx();
    await promisifyIDBRequest(db.delete(href));
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

  useList(effect: (list: string[]) => void): () => void {
    const unwatch = this.watch("*", (evt) => {
      if (evt.kind === "create" || evt.kind === "remove") {
        this.ls().then(effect);
      }
    });
    this.ls().then(effect);
    return () => {
      unwatch();
    };
  }

  useState(effect: (state: VFSState) => void): () => void {
    const handler = () => effect(this._state);
    this._stateChangeHandlers.add(handler);
    handler();
    return () => {
      this._stateChangeHandlers.delete(handler);
    };
  }

  bindMonaco(monaco: typeof monacoNS) {
    this._monaco = monaco;

    monaco.editor.addCommand({
      id: "vfs.importmap.add_module",
      run: async (_: unknown, importMapSrc: string, specifier: string, uri: string) => {
        const model = monaco.editor.getModel(monaco.Uri.parse(importMapSrc));
        const { imports, scopes } = model && importMapSrc.endsWith(".json")
          ? parseImportMapFromJson(model.getValue())
          : await loadImportMapFromVFS(this);
        imports[specifier] = uri;
        imports[specifier + "/"] = uri + "/";
        const json = JSON.stringify({ imports, scopes }, null, 2);
        if (importMapSrc.endsWith(".json")) {
          await this.writeFile(importMapSrc, model?.normalizeIndentation(json) ?? json);
        } else if (importMapSrc.endsWith(".html")) {
          const html = model?.getValue() ?? await this.readTextFile(importMapSrc);
          const newHtml = html.replace(
            /<script[^>]*?\s+type="importmap"\s*[^>]*>[^]*?<\/script>/,
            ["<script type=\"importmap\">", ...json.split("\n").map((l) => "  " + l), "</script>"].join("\n  "),
          );
          await this.writeFile(importMapSrc, model?.normalizeIndentation(newHtml) ?? newHtml);
        }
      },
    });
  }
}

/** Error for file not found. */
export class ErrorNotFound extends Error {
  constructor(name: string | URL) {
    super("file not found: " + name.toString());
  }
}
