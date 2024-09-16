import type monacoNS from "monaco-editor-core";

// ! external modules, don't remove the `.js` extension
import { createPersistTask, createSyncPersistTask } from "./util.js";
import { createProxy, decode, encode, promisifyIDBRequest, toUrl } from "./util.js";

interface VFSOptions {
  /** scope of the VFS, used for project isolation, default is "default" */
  scope?: string;
  /** initial files in the VFS */
  initial?: Record<string, string | Uint8Array>;
  /** file to open when the editor is loaded at first time */
  entryFile?: string;
  /** history provider, default is "localStorage" */
  history?: "localStorage" | "browserHistory" | VFSHistory;
}

interface VFSEvent {
  /** The kind of the event. */
  kind: "create" | "modify" | "remove";
  /** The path of the file. */
  path: string;
  /** If the event is triggered by model content change. */
  isModelContentChange?: boolean;
}

interface VFile {
  url: string;
  version: number;
  content: string | Uint8Array;
  ctime: number;
  mtime: number;
}

interface VFSHistory {
  readonly current: string;
  back(): void;
  forward(): void;
  push(name: string | URL): void;
  replace(name: string | URL): void;
  onChange(handler: (name: string) => void): () => void;
}

/** A virtual file system using IndexedDB. */
export class BasicVFS {
  private _db: Promise<IDBDatabase> | IDBDatabase;
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
  }

  get ErrorNotFound() {
    return ErrorNotFound;
  }

  private _openDB(options: VFSOptions): Promise<IDBDatabase> {
    const dbName = "monaco-vfs/" + (options.scope ?? "defualt");
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
      // reopen db on 'close' event
      db.onclose = () => {
        this._db = this._openDB(options);
      };
      return this._db = db;
    });
  }

  private async _tx(readonly = false): Promise<IDBObjectStore> {
    const db = await this._db;
    return db.transaction(VFS.dbStoreName, readonly ? "readonly" : "readwrite").objectStore(VFS.dbStoreName);
  }

  async exists(name: string | URL): Promise<boolean> {
    const url = toUrl(name);
    const store = await this._tx(true);
    return promisifyIDBRequest<string>(store.getKey(url.href)).then((key) => key === url.href);
  }

  async ls(): Promise<string[]> {
    const store = await this._tx(true);
    return await promisifyIDBRequest<string[]>(store.getAllKeys());
  }

  async open(name: string | URL): Promise<VFile> {
    const url = toUrl(name);
    const store = await this._tx(true);
    const ret = await promisifyIDBRequest<VFile | undefined>(store.get(url.href));
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

  async writeFile(name: string | URL, content: string | Uint8Array, version?: number, isModelContentChange?: boolean): Promise<void> {
    const { pathname, href: url } = toUrl(name);
    const store = await this._tx();
    const old = await promisifyIDBRequest<VFile | undefined>(store.get(url));
    const now = Date.now();
    const file: VFile = {
      url,
      version: version ?? (1 + (old?.version ?? 0)),
      content,
      ctime: old?.ctime ?? now,
      mtime: now,
    };
    await promisifyIDBRequest(store.put(file));
    setTimeout(() => {
      const kind = old ? "modify" : "create";
      for (const key of [url, "*"]) {
        const handlers = this._watchHandlers.get(key);
        if (handlers) {
          for (const handler of handlers) {
            handler({ kind, path: pathname, isModelContentChange });
          }
        }
      }
    }, 0);
  }

  async remove(name: string | URL): Promise<void> {
    const { pathname, href: url } = toUrl(name);
    const store = await this._tx();
    await promisifyIDBRequest(store.delete(url));
    setTimeout(() => {
      for (const key of [url, "*"]) {
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
}

/** A virtual file system for esm-monaco editor. */
export class VFS extends BasicVFS {
  private _monaco: typeof monacoNS;
  private _entryFile?: string;
  private _history: VFSHistory;
  private _viewState: Record<string, monacoNS.editor.ICodeEditorViewState> = {};

  constructor(options: VFSOptions) {
    super(options);
    this._entryFile = options.entryFile;
    if (options.history && typeof options.history === "object") {
      if (typeof options.history.push === "function") {
        this._history = options.history;
      }
    } else if (options.history === "browserHistory") {
      if (globalThis.history) {
        this._history = new VFSBrowserHistory("/");
      }
    } else if (supportLocalStroage()) {
      this._history = new VFSLocalStorageHistory(options.scope ?? "default");
    }
    if (supportLocalStroage()) {
      this._viewState = createPersistStateStorage("monaco:vfs.viewState." + (options.scope ?? "default"));
    }
  }

  get entryFile() {
    return this._entryFile;
  }

  get history() {
    return this._history;
  }

  get viewState() {
    return this._viewState;
  }

  async openModel(
    name: string | URL,
    editor?: monacoNS.editor.ICodeEditor,
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
      const persist = createPersistTask(() => this.writeFile(href, model.getValue(), version + model.getVersionId(), true));
      const disposable = model.onDidChangeContent(persist);
      const unwatch = this.watch(href, async (evt) => {
        if (evt.kind === "modify" && !evt.isModelContentChange) {
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
        if (pos) {
          const svp = editor.getScrolledVisiblePosition(new monaco.Position(pos.lineNumber - 7, pos.column));
          if (svp) {
            editor.setScrollTop(svp.top);
          }
        }
      } else {
        this._viewState[href] && editor.restoreViewState(this._viewState[href]);
      }
      if (this._history.current !== href) {
        this._history.push(href);
      }
    }
    return model;
  }

  setup(monaco: typeof monacoNS) {
    this._monaco = monaco;
  }
}

export class VFSBrowserHistory implements VFSHistory {
  private _basePath = "";
  private _current = "";
  private _handlers = new Set<(name: string) => void>();

  constructor(basePath = "") {
    this._basePath = "/" + basePath.split("/").filter(Boolean).join("/");
    this._current = this._trimBasePath(location.pathname);
    window.addEventListener("popstate", () => {
      this._current = this._trimBasePath(location.pathname);
      this._onPopState();
    });
  }

  private _trimBasePath(pathname: string) {
    if (pathname != "/" && pathname.startsWith(this._basePath)) {
      return new URL(pathname.slice(this._basePath.length), "file:///").href;
    }
    return "";
  }

  private _joinBasePath(url: URL) {
    const basePath = this._basePath === "/" ? "" : this._basePath;
    if (url.protocol === "file:") {
      return basePath + url.pathname;
    }
    return basePath + "/" + url.href;
  }

  private _onPopState() {
    for (const handler of this._handlers) {
      handler(this._current);
    }
  }

  get current(): string {
    return this._current;
  }

  back(): void {
    history.back();
  }

  forward(): void {
    history.forward();
  }

  push(name: string | URL): void {
    const url = toUrl(name);
    history.pushState(null, "", this._joinBasePath(url));
    this._current = url.href;
    this._onPopState();
  }

  replace(name: string | URL): void {
    const url = toUrl(name);
    history.replaceState(null, "", this._joinBasePath(url));
    this._current = url.href;
    this._onPopState();
  }

  onChange(handler: (path: string) => void): () => void {
    this._handlers.add(handler);
    return () => {
      this._handlers.delete(handler);
    };
  }
}

export class VFSLocalStorageHistory implements VFSHistory {
  private _state: { current: number; history: string[] };
  private _maxHistory: number;
  private _handlers = new Set<(name: string) => void>();

  constructor(scope: string, maxHistory = 100) {
    this._state = createPersistStateStorage("monaco:vfs.history." + scope, {
      current: -1,
      history: [],
    });
    this._maxHistory = maxHistory;
  }

  private _onPopState() {
    for (const handler of this._handlers) {
      handler(this.current);
    }
  }

  get current(): string {
    return this._state.history[this._state.current] ?? "";
  }

  back(): void {
    this._state.current--;
    if (this._state.current < 0) {
      this._state.current = 0;
    }
    this._onPopState();
  }

  forward(): void {
    this._state.current++;
    if (this._state.current >= this._state.history.length) {
      this._state.current = this._state.history.length - 1;
    }
    this._onPopState();
  }

  push(name: string | URL): void {
    const url = toUrl(name);
    const history = this._state.history.slice(0, this._state.current + 1);
    history.push(url.href);
    if (history.length > this._maxHistory) {
      history.shift();
    }
    this._state.history = history;
    this._state.current = history.length - 1;
    this._onPopState();
  }

  replace(name: string | URL): void {
    const url = toUrl(name);
    const history = [...this._state.history]; // copy the array
    if (this._state.current === -1) {
      this._state.current = 0;
    }
    history[this._state.current] = url.href;
    this._state.history = history;
    this._onPopState();
  }

  onChange(handler: (path: string) => void): () => void {
    this._handlers.add(handler);
    return () => {
      this._handlers.delete(handler);
    };
  }
}

/** Create a proxy object that triggers persist in localStorage when the object is modified. */
function createPersistStateStorage<T extends object>(storeKey: string, defaultValue?: T): T {
  let state: T;
  const init = defaultValue ?? {} as T;
  const storeValue = localStorage.getItem(storeKey);
  if (storeValue) {
    try {
      for (const [key, value] of Object.entries(JSON.parse(storeValue))) {
        init[key] = Object.freeze(value);
      }
    } catch (e) {
      console.error(e);
    }
  }
  const persist = createSyncPersistTask(() => localStorage.setItem(storeKey, JSON.stringify(state)), 1000);
  return state = createProxy(init, persist);
}

function supportLocalStroage() {
  if (globalThis.localStorage) {
    try {
      localStorage.setItem(".__", "");
      localStorage.removeItem(".__");
      return true;
    } catch {}
  }
  return false;
}

/** Error for file not found. */
export class ErrorNotFound extends Error {
  constructor(name: string | URL) {
    super("file not found: " + name.toString());
  }
}
