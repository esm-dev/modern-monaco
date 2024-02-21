import type monacoNS from "monaco-editor-core";
import { parseImportMapFromJson, readImportMap } from "./import-map";
import { createPersistTask, createProxy, decode, defineProperty, encode, toUrl } from "./util";

interface VFile {
  url: string;
  version: number;
  content: string | Uint8Array;
  ctime: number;
  mtime: number;
  headers?: [string, string][];
}

interface WatchEvent {
  kind: "create" | "modify" | "remove";
  path: string;
  isModelChange?: boolean;
}

interface VFSOptions {
  scope?: string;
  initial?: Record<string, string[] | string | Uint8Array>;
}

/** Virtual file system for monaco editor. */
export class VFS {
  #db: Promise<IDBDatabase> | IDBDatabase;
  #monaco: typeof monacoNS;
  #state: Record<string, any> = {};
  #stateOnChangeHandlers = new Set<() => void>();
  #watchHandlers = new Map<string, Set<(evt: WatchEvent) => void>>();

  constructor(options: VFSOptions) {
    const dbName = "monaco-vfs:" + (options.scope ?? "main");
    const req = openDB(
      dbName,
      async (store) => {
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
          await waitIDBRequest(store.add(item));
        }
      },
    );
    this.#db = req.then((db) => this.#db = db);
    if (globalThis.localStorage) {
      const state = {};
      const storeKey = "monaco-state:" + (options.scope ?? "main");
      const persist = createPersistTask(() => {
        localStorage.setItem(storeKey, JSON.stringify(this.#state));
      }, 100);
      const storeValue = localStorage.getItem(storeKey);
      if (storeValue) {
        try {
          Object.assign(state, JSON.parse(storeValue));
        } catch (e) {
          console.error(e);
        }
      }
      this.#state = createProxy(state, () => {
        this.#stateOnChangeHandlers.forEach((handler) => handler());
        persist();
      });
    }
  }

  get ErrorNotFound() {
    return ErrorNotFound;
  }

  get state() {
    return this.#state;
  }

  async #begin(readonly = false) {
    const db = await this.#db;
    return db.transaction("files", readonly ? "readonly" : "readwrite").objectStore("files");
  }

  bindMonaco(monaco: typeof monacoNS) {
    monaco.editor.addCommand({
      id: "vfs.importmap.add_module",
      run: async (_: unknown, importMapSrc: string, specifier: string, uri: string) => {
        const model = monaco.editor.getModel(monaco.Uri.parse(importMapSrc));
        const { imports, scopes } = model && importMapSrc.endsWith(".json")
          ? parseImportMapFromJson(model.getValue())
          : await readImportMap(this);
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
    this.#monaco = monaco;
  }

  async openModel(
    name: string | URL,
    attachTo?: monacoNS.editor.ICodeEditor | number | string | boolean,
    selectionOrPosition?: monacoNS.IRange | monacoNS.IPosition,
  ) {
    const monaco = this.#monaco;
    if (!monaco) {
      throw new Error("monaco is undefined");
    }
    const url = toUrl(name);
    const href = url.href;
    const uri = monaco.Uri.parse(href);
    const { content, version } = await this.#read(url);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(decode(content), undefined, uri);
    if (!Reflect.has(model, "__VFS__")) {
      const onDidChange = createPersistTask(() => {
        return this.writeFile(uri.toString(), model.getValue(), version + model.getVersionId(), true);
      }, 500);
      const disposable = model.onDidChangeContent(onDidChange);
      const unwatch = this.watch(href, async (evt) => {
        if (evt.kind === "modify" && !evt.isModelChange) {
          const { content } = await this.#read(url);
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
          const viewState = this.#state.viewState?.[href];
          if (viewState) {
            editor.restoreViewState(viewState);
          }
        }
        if (this.#state.activeFile !== href) {
          this.#state.activeFile = href;
        }
      }
    }
    return model;
  }

  async exists(name: string | URL): Promise<boolean> {
    const url = toUrl(name);
    const db = await this.#begin(true);
    return waitIDBRequest<string>(db.getKey(url.href)).then((key) => !!key);
  }

  async list() {
    const db = await this.#begin(true);
    const req = db.getAllKeys();
    return await waitIDBRequest<string[]>(req);
  }

  async #read(name: string | URL) {
    const url = toUrl(name);
    const db = await this.#begin(true);
    const ret = await waitIDBRequest<VFile>(db.get(url.href));
    if (!ret) {
      throw new ErrorNotFound(name);
    }
    return ret;
  }

  async readFile(name: string | URL) {
    const { content } = await this.#read(name);
    return encode(content);
  }

  async readTextFile(name: string | URL) {
    const { content } = await this.#read(name);
    return decode(content);
  }

  async #write(
    url: string,
    content: string | Uint8Array,
    version?: number,
  ) {
    const db = await this.#begin();
    const old = await waitIDBRequest<VFile>(db.get(url));
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

  async writeFile(
    name: string | URL,
    content: string | Uint8Array,
    version?: number,
    isModelChange?: boolean,
  ) {
    const url = toUrl(name);
    const kind = await this.#write(url.href, content, version);
    setTimeout(() => {
      for (const key of [url.href, "*"]) {
        const handlers = this.#watchHandlers.get(key);
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
    const db = await this.#begin();
    await waitIDBRequest(db.delete(href));
    setTimeout(() => {
      for (const key of [href, "*"]) {
        const handlers = this.#watchHandlers.get(key);
        if (handlers) {
          for (const handler of handlers) {
            handler({ kind: "remove", path: pathname });
          }
        }
      }
    }, 0);
  }

  watch(
    name: string | URL,
    handler: (evt: WatchEvent) => void,
  ): () => void {
    const url = name == "*" ? name : toUrl(name).href;
    let handlers = this.#watchHandlers.get(url);
    if (!handlers) {
      handlers = new Set();
      this.#watchHandlers.set(url, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers!.delete(handler);
    };
  }

  watchState(handler: () => void): () => void {
    this.#stateOnChangeHandlers.add(handler);
    return () => {
      this.#stateOnChangeHandlers.delete(handler);
    };
  }

  useList(handler: (list: string[]) => void): () => void {
    const unwatch = this.watch("*", (evt) => {
      if (evt.kind === "create" || evt.kind === "remove") {
        this.list().then(handler);
      }
    });
    this.list().then(handler);
    return () => {
      unwatch();
    };
  }

  useState<T>(get: (state: any) => T, handler: (value: T) => void): () => void {
    let value = get(this.#state);
    handler(value);
    const unwatch = this.watchState(() => {
      const newValue = get(this.#state);
      if (newValue !== value) {
        value = newValue;
        handler(value);
      }
    });
    return () => {
      unwatch();
    };
  }

  fetch(url: string | URL) {
    return vfetch(url);
  }
}

/** Error for file not found. */
export class ErrorNotFound extends Error {
  constructor(name: string | URL) {
    super("file not found: " + name.toString());
  }
}

/** Open the given IndexedDB database. */
export function openDB(
  name: string,
  onStoreCreate?: (store: IDBObjectStore) => void | Promise<void>,
) {
  const req = indexedDB.open(name, 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains("files")) {
      const store = db.createObjectStore("files", { keyPath: "url" });
      onStoreCreate?.(store);
    }
  };
  return waitIDBRequest<IDBDatabase>(req);
}

/** wait for the given IDBRequest. */
export function waitIDBRequest<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The cache storage in IndexedDB. */
let cacheDb: Promise<IDBDatabase> | IDBDatabase | null = null;

/** Fetch with vfs cache. */
export async function vfetch(url: string | URL): Promise<Response> {
  url = toUrl(url);
  if (!globalThis.indexedDB) {
    // non-browser environment
    return fetch(url);
  }
  const cachedRes = await vfetch.queryCache(url);
  if (cachedRes) {
    return cachedRes;
  }
  const res = await fetch(url);
  if (res.ok) {
    const content = new Uint8Array(await res.arrayBuffer());
    const headers = [...res.headers.entries()].filter(([k]) =>
      ["cache-control", "content-type", "content-length", "x-typescript-types"].includes(k)
    );
    if (res.redirected) {
      headers.push(["x-redirected-url", res.url]);
    }
    const now = Date.now();
    const file: VFile = {
      url: url.href,
      version: 1,
      content,
      headers,
      ctime: now,
      mtime: now,
    };
    const db = await (cacheDb ?? (cacheDb = openDB("monaco-cache")));
    const tx = db.transaction("files", "readwrite").objectStore("files");
    await waitIDBRequest<VFile>(tx.put(file));
    const resp = new Response(content, { headers });
    defineProperty(resp, "url", res.url);
    defineProperty(resp, "redirected", res.redirected);
    return resp;
  }
  return res;
}
vfetch.queryCache = async (url: string | URL): Promise<Response | null> => {
  url = toUrl(url);
  const db = await (cacheDb ?? (cacheDb = openDB("monaco-cache")));
  const tx = db.transaction("files", "readonly").objectStore("files");
  const ret = await waitIDBRequest<VFile>(tx.get(url.href));
  if (ret && ret.headers) {
    const headers = new Headers(ret.headers);
    const res = new Response(ret.content, { headers });
    if (headers.has("x-redirected-url")) {
      defineProperty(res, "url", headers.get("x-redirected-url"));
      defineProperty(res, "redirected", true);
      headers.delete("x-redirected-url");
    } else {
      defineProperty(res, "url", url.href);
    }
    return res;
  }
  return null;
};
