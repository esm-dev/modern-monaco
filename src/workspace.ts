import type monacoNS from "monaco-editor-core";
import type {
  FileStat,
  FileSystem,
  Workspace as IWorkspace,
  WorkspaceHistory,
  WorkspaceHistoryState,
  WorkspaceInit,
  WorkspaceViewState,
} from "../types/workspace.d.ts";

// ! external modules, don't remove the `.js` extension
import {
  createPersistStateStorage,
  createPersistTask,
  decode,
  encode,
  filenameToURL,
  openIDB,
  openIDBCursor,
  promiseWithResolvers,
  promisifyIDBRequest,
  supportLocalStorage,
  toURL,
} from "./util.js";

/** class Workspace implements IWorkspace */
export class Workspace implements IWorkspace {
  private _monaco: { promise: Promise<typeof monacoNS>; resolve: (value: typeof monacoNS) => void; reject: (reason: any) => void };
  private _history: WorkspaceHistory;
  private _fs: FileSystem;
  private _viewState: WorkspaceViewState;
  private _entryFile?: string;

  constructor(options: WorkspaceInit = {}) {
    const { name = "default", browserHistory, initialFiles, entryFile, customFs } = options;
    
    // Create database stores - viewstate store only needed when using default FS
    const dbStores = [
      {
        name: "fs-meta",
        keyPath: "url",
        onCreate: async (store: IDBObjectStore) => {
          if (initialFiles) {
            const promises: Promise<void>[] = [];
            const now = Date.now();
            const reg: FileStat = { type: 1, version: 1, ctime: now, mtime: now, size: 0 };
            const dir: FileStat = { type: 2, version: 1, ctime: now, mtime: now, size: 0 };
            for (const [name, data] of Object.entries(initialFiles)) {
              const { pathname, href: url } = filenameToURL(name);
              let parent = pathname.slice(0, pathname.lastIndexOf("/"));
              while (parent) {
                promises.push(
                  promisifyIDBRequest(
                    store.put({ url: toURL(parent).href, ...dir }),
                  ),
                );
                parent = parent.slice(0, parent.lastIndexOf("/"));
              }
              promises.push(
                promisifyIDBRequest(
                  store.put({ url, ...reg, size: encode(data).byteLength }),
                ),
              );
            }
            await Promise.all(promises);
          }
        },
      },
      {
        name: "fs-blob",
        keyPath: "url",
        onCreate: async (store: IDBObjectStore) => {
          if (initialFiles) {
            const promises: Promise<void>[] = [];
            for (const [name, data] of Object.entries(initialFiles)) {
              promises.push(
                promisifyIDBRequest(
                  store.put({ url: filenameToURL(name).href, content: encode(data) }),
                ),
              );
            }
            await Promise.all(promises);
          }
        },
      },
    ];
    
    // Only add viewstate store if using default filesystem (for backward compatibility)
    if (!customFs) {
      dbStores.push({
        name: "viewstate",
        keyPath: "url",
        onCreate: async (_store: IDBObjectStore) => {
          // No initial setup needed for viewstate store
        },
      });
    }
    
    const db = new WorkspaceDatabase(name, ...dbStores);

    this._monaco = promiseWithResolvers();
    this._fs = customFs ?? new FS(db);
    this._viewState = new WorkspaceStateStorage<monacoNS.editor.ICodeEditorViewState>(this._fs, "viewstate");
    this._entryFile = entryFile;

    if (browserHistory) {
      if (!globalThis.history) {
        throw new Error("Browser history is not supported.");
      }
      this._history = new BrowserHistory(browserHistory === true ? "/" : browserHistory.basePath);
    } else {
      this._history = new LocalStorageHistory(name);
    }
  }

  setupMonaco(monaco: typeof monacoNS) {
    this._monaco.resolve(monaco);
  }

  get entryFile() {
    return this._entryFile;
  }

  get fs() {
    return this._fs;
  }

  get history() {
    return this._history;
  }

  get viewState() {
    return this._viewState;
  }

  async openTextDocument(uri: string | URL, content?: string): Promise<monacoNS.editor.ITextModel> {
    const monaco = await this._monaco.promise;
    return this._openTextDocument(uri, monaco.editor.getEditors()[0]);
  }

  // @internal
  async _openTextDocument(
    uri: string | URL,
    editor?: monacoNS.editor.ICodeEditor,
    selectionOrPosition?: monacoNS.IRange | monacoNS.IPosition,
  ): Promise<monacoNS.editor.ITextModel> {
    const monaco = await this._monaco.promise;
    const fs = this._fs;
    const href = toURL(uri).href;
    const content = await fs.readTextFile(href);
    const viewState = await this.viewState.get(href);
    const modelUri = monaco.Uri.parse(href);
    const model = monaco.editor.getModel(modelUri) ?? monaco.editor.createModel(content, undefined, modelUri);
    if (!Reflect.has(model, "__OB__")) {
      const persist = createPersistTask(() => fs.writeFile(href, model.getValue(), { isModelContentChange: true }));
      const disposable = model.onDidChangeContent(persist);
      const unwatch = fs.watch(href, (kind, _, __, context) => {
        if (kind === "modify" && (!context || !context.isModelContentChange)) {
          fs.readTextFile(href).then((content) => {
            if (model.getValue() !== content) {
              model.setValue(content);
              model.pushStackElement();
            }
          });
        }
      });
      model.onWillDispose(() => {
        Reflect.deleteProperty(model, "__OB__");
        disposable.dispose();
        unwatch();
      });
      Reflect.set(model, "__OB__", true);
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
      } else if (viewState) {
        editor.restoreViewState(viewState);
      }
      if (this._history.state.current !== href) {
        this._history.push(href);
      }
    }
    return model;
  }

  async showInputBox(options: monacoNS.InputBoxOptions, token: monacoNS.CancellationToken) {
    const monaco = await this._monaco.promise;
    return monaco.showInputBox(options, token);
  }

  async showQuickPick(items: any, options: any, token: monacoNS.CancellationToken) {
    const monaco = await this._monaco.promise;
    return monaco.showQuickPick(items, options, token) as any;
  }
}

type FileSystemWatcher = {
  pathname: string;
  recursive?: boolean;
  handle: (kind: "create" | "modify" | "remove", filename: string, type?: number, context?: any) => void;
};

/** workspace file system using IndexedDB. */
class FS implements FileSystem {
  private _watchers = new Set<FileSystemWatcher>();

  constructor(private _db: WorkspaceDatabase) {}

  private async _getIdbObjectStore(storeName: string, readwrite = false): Promise<IDBObjectStore> {
    const db = await this._db.open();
    return db.transaction(storeName, readwrite ? "readwrite" : "readonly").objectStore(storeName);
  }

  private async _getIdbObjectStores(readwrite = false): Promise<[IDBObjectStore, IDBObjectStore]> {
    const transaction = (await this._db.open()).transaction(["fs-meta", "fs-blob"], readwrite ? "readwrite" : "readonly");
    return [transaction.objectStore("fs-meta"), transaction.objectStore("fs-blob")];
  }

  /**
   * read the fs entries
   * @internal
   */
  async entries(): Promise<[string, number][]> {
    const metaStore = await this._getIdbObjectStore("fs-meta");
    const entries = await promisifyIDBRequest<Array<{ url: string } & FileStat>>(metaStore.getAll());
    return entries.map(({ url, type }) => [url, type]);
  }

  async stat(name: string): Promise<FileStat> {
    const url = filenameToURL(name).href;
    if (url === "file:///") {
      return { type: 2, version: 1, ctime: 0, mtime: 0, size: 0 };
    }
    const metaStore = await this._getIdbObjectStore("fs-meta");
    const stat = await promisifyIDBRequest<FileStat | undefined>(metaStore.get(url));
    if (!stat) {
      throw new ErrorNotFound(url);
    }
    return stat;
  }

  async createDirectory(name: string): Promise<void> {
    const now = Date.now();
    const { pathname, href: url } = filenameToURL(name);
    const metaStore = await this._getIdbObjectStore("fs-meta", true);
    const promises: Promise<void>[] = [];
    const newDirs: string[] = [];
    // ensure parent directories exist
    let parent = pathname.slice(0, pathname.lastIndexOf("/"));
    while (parent) {
      const stat: FileStat = { type: 2, version: 1, ctime: now, mtime: now, size: 0 };
      promises.push(
        promisifyIDBRequest<void>(metaStore.add({ url: filenameToURL(parent).href, ...stat })).catch((error) => {
          if (error.name !== "ConstraintError") {
            throw error;
          }
        }),
      );
      newDirs.push(parent);
      parent = parent.slice(0, parent.lastIndexOf("/"));
    }
    const stat: FileStat = { type: 2, version: 1, ctime: now, mtime: now, size: 0 };
    promises.push(
      promisifyIDBRequest<void>(metaStore.add({ url, ...stat })).catch((error) => {
        if (error.name !== "ConstraintError") {
          throw error;
        }
      }),
    );
    newDirs.push(pathname);
    await Promise.all(promises);
    for (const dir of newDirs) {
      this._notify("create", dir, 2);
    }
  }

  async readDirectory(name: string): Promise<[string, number][]> {
    const { pathname } = filenameToURL(name);
    const stat = await this.stat(name);
    if (stat.type !== 2) {
      throw new Error(`read ${pathname}: not a directory`);
    }
    const metaStore = await this._getIdbObjectStore("fs-meta");
    const entries: [string, number][] = [];
    const dir = "file://" + pathname + (pathname.endsWith("/") ? "" : "/");
    await openIDBCursor(metaStore, IDBKeyRange.lowerBound(dir, true), (cursor) => {
      const stat = cursor.value;
      if (stat.url.startsWith(dir)) {
        const name = stat.url.slice(dir.length);
        if (name !== "" && name.indexOf("/") === -1) {
          entries.push([name, stat.type]);
        }
        return true;
      }
      return false;
    });
    return entries;
  }

  async readFile(name: string): Promise<Uint8Array> {
    const url = filenameToURL(name).href;
    const blobStore = await this._getIdbObjectStore("fs-blob");
    const file = await promisifyIDBRequest<{ content: Uint8Array }>(blobStore.get(url));
    if (!file) {
      throw new ErrorNotFound(url);
    }
    return file.content;
  }

  async readTextFile(filename: string): Promise<string> {
    return this.readFile(filename).then(decode);
  }

  async writeFile(name: string, content: string | Uint8Array, context?: any): Promise<void> {
    const { pathname, href: url } = filenameToURL(name);
    const dir = pathname.slice(0, pathname.lastIndexOf("/"));
    if (dir) {
      try {
        if ((await this.stat(dir)).type !== 2) {
          throw new Error(`write ${pathname}: not a directory`);
        }
      } catch (error) {
        if (error instanceof ErrorNotFound) {
          throw new Error(`write ${pathname}: no such file or directory`);
        }
        throw error;
      }
    }
    let oldStat: FileStat | null = null;
    try {
      oldStat = await this.stat(url);
    } catch (error) {
      if (!(error instanceof ErrorNotFound)) {
        throw error;
      }
    }
    if (oldStat?.type === 2) {
      throw new Error(`write ${pathname}: is a directory`);
    }
    content = typeof content === "string" ? encode(content) : content;
    const now = Date.now();
    const newStat: FileStat = {
      type: 1,
      version: (oldStat?.version ?? 0) + 1,
      ctime: oldStat?.ctime ?? now,
      mtime: now,
      size: content.byteLength,
    };
    const [metaStore, blobStore] = await this._getIdbObjectStores(true);
    await Promise.all([
      promisifyIDBRequest(metaStore.put({ url, ...newStat })),
      promisifyIDBRequest(blobStore.put({ url, content })),
    ]);
    this._notify(oldStat ? "modify" : "create", pathname, 1, context);
  }

  async delete(name: string, options?: { recursive: boolean }): Promise<void> {
    const { pathname, href: url } = filenameToURL(name);
    const stat = await this.stat(url);
    if (stat.type === 1 /* File */) {
      const [metaStore, blobStore] = await this._getIdbObjectStores(true);
      await Promise.all([
        promisifyIDBRequest(metaStore.delete(url)),
        promisifyIDBRequest(blobStore.delete(url)),
      ]);
      this._notify("remove", pathname, 1);
    } else if (stat.type === 2 /* Directory */) {
      if (options?.recursive) {
        const promises: Promise<void>[] = [];
        const [metaStore, blobStore] = await this._getIdbObjectStores(true);
        const deleted: [string, number][] = [];
        promises.push(openIDBCursor(metaStore, IDBKeyRange.lowerBound(url), (cursor) => {
          const stat = cursor.value;
          if (stat.url.startsWith(url)) {
            if (stat.type === 1) {
              promises.push(promisifyIDBRequest(blobStore.delete(stat.url)));
            }
            promises.push(promisifyIDBRequest(cursor.delete()));
            deleted.push([stat.url, stat.type]);
            return true;
          }
          return false;
        }));
        await Promise.all(promises);
        for (const [url, type] of deleted) {
          this._notify("remove", new URL(url).pathname, type);
        }
      } else {
        const entries = await this.readDirectory(url);
        if (entries.length > 0) {
          throw new Error(`delete ${url}: directory not empty`);
        }
        const metaStore = await this._getIdbObjectStore("fs-meta", true);
        await promisifyIDBRequest(metaStore.delete(url));
        this._notify("remove", pathname, 2);
      }
    } else {
      const metaStore = await this._getIdbObjectStore("fs-meta", true);
      await promisifyIDBRequest(metaStore.delete(url));
      this._notify("remove", pathname, stat.type);
    }
  }

  async copy(source: string, target: string, options?: { overwrite: boolean }): Promise<void> {
    throw new Error("Method not implemented.");
  }

  async rename(oldName: string, newName: string, options?: { overwrite: boolean }): Promise<void> {
    const { href: oldUrl, pathname: oldPath } = filenameToURL(oldName);
    const { href: newUrl, pathname: newPath } = filenameToURL(newName);
    const oldStat = await this.stat(oldUrl);
    try {
      const stat = await this.stat(newUrl);
      if (!options?.overwrite) {
        throw new Error(`rename ${oldUrl} to ${newUrl}: file exists`);
      }
      await this.delete(newUrl, stat.type === 2 ? { recursive: true } : undefined);
    } catch (error) {
      if (!(error instanceof ErrorNotFound)) {
        throw error;
      }
    }
    const newPathDirname = newPath.slice(0, newPath.lastIndexOf("/"));
    if (newPathDirname) {
      try {
        if ((await this.stat(newPathDirname)).type !== 2) {
          throw new Error(`rename ${oldUrl} to ${newUrl}: Not a directory`);
        }
      } catch (error) {
        if (error instanceof ErrorNotFound) {
          throw new Error(`rename ${oldUrl} to ${newUrl}: No such file or directory`);
        }
        throw error;
      }
    }
    const [metaStore, blobStore] = await this._getIdbObjectStores(true);
    const promises: Promise<any>[] = [
      promisifyIDBRequest(metaStore.delete(oldUrl)),
      promisifyIDBRequest(metaStore.put({ ...oldStat, url: newUrl })),
    ];
    const renameBlob = (oldUrl: string, newUrl: string) =>
      openIDBCursor(blobStore, IDBKeyRange.only(oldUrl), (cursor) => {
        promises.push(promisifyIDBRequest(blobStore.put({ url: newUrl, content: cursor.value.content })));
        promises.push(promisifyIDBRequest(cursor.delete()));
      });
    const moved: [string, string, number][] = [[oldPath, newPath, oldStat.type]];
    if (oldStat.type === 1) {
      promises.push(renameBlob(oldUrl, newUrl));
    } else if (oldStat.type === 2) {
      let dirUrl = oldUrl;
      if (!dirUrl.endsWith("/")) {
        dirUrl += "/";
      }
      const renamingChildren = openIDBCursor(
        metaStore,
        IDBKeyRange.lowerBound(dirUrl, true),
        (cursor) => {
          const stat = cursor.value;
          if (stat.url.startsWith(dirUrl)) {
            const url = newUrl + stat.url.slice(dirUrl.length - 1);
            if (stat.type === 1) {
              promises.push(renameBlob(stat.url, url));
            }
            promises.push(promisifyIDBRequest(metaStore.put({ ...stat, url })));
            promises.push(promisifyIDBRequest(cursor.delete()));
            moved.push([new URL(stat.url).pathname, new URL(url).pathname, stat.type]);
            return true;
          }
          return false;
        },
      );
      promises.push(renamingChildren);
    }
    await Promise.all(promises);
    for (const [oldPath, newPath, type] of moved) {
      this._notify("remove", oldPath, type);
      this._notify("create", newPath, type);
    }
  }

  watch(filename: string, handle: FileSystemWatcher["handle"]): () => void;
  watch(filename: string, options: { recursive: boolean }, handle: FileSystemWatcher["handle"]): () => void;
  watch(
    filename: string,
    handleOrOptions: FileSystemWatcher["handle"] | { recursive: boolean },
    handle?: FileSystemWatcher["handle"],
  ): () => void {
    const options = typeof handleOrOptions === "function" ? undefined : handleOrOptions;
    handle = typeof handleOrOptions === "function" ? handleOrOptions : handle!;
    if (typeof handle !== "function") {
      throw new TypeError("handle must be a function");
    }
    const watcher: FileSystemWatcher = { pathname: filenameToURL(filename).pathname, recursive: options?.recursive ?? false, handle };
    this._watchers.add(watcher);
    return () => {
      this._watchers.delete(watcher);
    };
  }

  private async _notify(kind: "create" | "modify" | "remove", pathname: string, type?: number, context?: any) {
    for (const watcher of this._watchers) {
      if (
        watcher.pathname === pathname || (watcher.recursive && (watcher.pathname === "/" || pathname.startsWith(watcher.pathname + "/")))
      ) {
        watcher.handle(kind, pathname, type, context);
      }
    }
  }
}

/** Error for file not found. */
export class ErrorNotFound extends Error {
  constructor(name: string) {
    super("No such file or directory: " + name);
  }
}

/** WorkspaceDatabase provides workspace database. */
class WorkspaceDatabase {
  private _db: Promise<IDBDatabase> | IDBDatabase;

  constructor(
    workspaceName: string,
    ...stores: { name: string; keyPath: string; onCreate?: (store: IDBObjectStore) => Promise<void> }[]
  ) {
    const open = () =>
      openIDB("modern-monaco-workspace/" + workspaceName, 1, ...stores).then((db) => {
        db.onclose = () => {
          // reopen the db on 'close' event
          this._db = open();
        };
        return this._db = db;
      });
    this._db = open();
  }

  async open(): Promise<IDBDatabase> {
    return await this._db;
  }
}

/** workspace state storage */
class WorkspaceStateStorage<T> {
  constructor(private _fs: FileSystem, private _stateName: string) {}

  private _getStateFilePath(uri: string | URL): string {
    const url = toURL(uri).href;
    // Create a safe filename from the URL by encoding it
    const encodedUrl = encodeURIComponent(url).replace(/%/g, '_');
    return `/.tmp/${this._stateName}/${encodedUrl}.json`;
  }

  async get(uri: string | URL): Promise<T | undefined> {
    try {
      const stateFilePath = this._getStateFilePath(uri);
      const content = await this._fs.readTextFile(stateFilePath);
      const parsed = JSON.parse(content);
      return parsed.state;
    } catch (_error) {
      // File doesn't exist or parsing failed, return undefined
      return undefined;
    }
  }

  async save(uri: string | URL, state: T): Promise<void> {
    const stateFilePath = this._getStateFilePath(uri);
    const stateDir = `/.tmp/${this._stateName}`;
    
    // Ensure the state directory exists
    try {
      await this._fs.createDirectory(stateDir);
    } catch (_error) {
      // Directory might already exist, ignore the error
    }
    
    const stateData = { url: toURL(uri).href, state };
    await this._fs.writeFile(stateFilePath, JSON.stringify(stateData));
  }
}

/** local storage workspace history */
class LocalStorageHistory implements WorkspaceHistory {
  private _state: { current: number; history: string[] };
  private _maxHistory: number;
  private _handlers = new Set<(state: WorkspaceHistoryState) => void>();

  constructor(scope: string, maxHistory = 100) {
    const defaultState = { "current": -1, "history": [] };
    this._state = supportLocalStorage()
      ? createPersistStateStorage("modern-monaco-workspace-history:" + scope, defaultState)
      : defaultState;
    this._maxHistory = maxHistory;
  }

  private _onPopState() {
    for (const handler of this._handlers) {
      handler(this.state);
    }
  }

  get state(): WorkspaceHistoryState {
    return { current: this._state.history[this._state.current] ?? "" };
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

  push(name: string): void {
    const url = filenameToURL(name);
    const history = this._state.history.slice(0, this._state.current + 1);
    history.push(url.href);
    if (history.length > this._maxHistory) {
      history.shift();
    }
    this._state.history = history;
    this._state.current = history.length - 1;
    this._onPopState();
  }

  replace(name: string): void {
    const url = filenameToURL(name);
    const history = [...this._state.history]; // copy the array
    if (this._state.current === -1) {
      this._state.current = 0;
    }
    history[this._state.current] = url.href;
    this._state.history = history;
    this._onPopState();
  }

  onChange(handler: (state: WorkspaceHistoryState) => void): () => void {
    this._handlers.add(handler);
    return () => {
      this._handlers.delete(handler);
    };
  }
}

/** browser workspace history */
class BrowserHistory implements WorkspaceHistory {
  private _basePath = "";
  private _current = "";
  private _handlers = new Set<(state: WorkspaceHistoryState) => void>();

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
      handler(this.state);
    }
  }

  get state(): WorkspaceHistoryState {
    return { current: this._current };
  }

  back(): void {
    history.back();
  }

  forward(): void {
    history.forward();
  }

  push(name: string): void {
    const url = filenameToURL(name);
    history.pushState(null, "", this._joinBasePath(url));
    this._current = url.href;
    this._onPopState();
  }

  replace(name: string): void {
    const url = filenameToURL(name);
    history.replaceState(null, "", this._joinBasePath(url));
    this._current = url.href;
    this._onPopState();
  }

  onChange(handler: (state: WorkspaceHistoryState) => void): () => void {
    this._handlers.add(handler);
    return () => {
      this._handlers.delete(handler);
    };
  }
}
