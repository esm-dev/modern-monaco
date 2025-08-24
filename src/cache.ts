// ! external modules, don't remove the `.js` extension
import { defineProperty, openIDB, promisifyIDBRequest, toURL } from "./util.js";

interface CacheFile {
  url: string;
  content: ArrayBuffer | null;
  ctime: number;
  headers?: [string, string][];
}

interface CacheDB {
  get(url: string): Promise<CacheFile | null>;
  put(file: CacheFile): Promise<void>;
}

class IndexedDB implements CacheDB {
  #db: Promise<IDBDatabase> | IDBDatabase;
  constructor(name: string) {
    this.#db = this.#openDB(name);
  }

  #openDB(name: string): Promise<IDBDatabase> {
    return openIDB(name, 1, { name: "store", keyPath: "url" }).then((db) => {
      db.onclose = () => {
        this.#db = this.#openDB(name);
      };
      return this.#db = db;
    });
  }

  async get(url: string): Promise<CacheFile | null> {
    const db = await this.#db;
    const tx = db.transaction("store", "readonly").objectStore("store");
    return promisifyIDBRequest<CacheFile>(tx.get(url));
  }

  async put(file: CacheFile): Promise<void> {
    const db = await this.#db;
    const tx = db.transaction("store", "readwrite").objectStore("store");
    await promisifyIDBRequest<CacheFile>(tx.put(file));
  }
}

class MemoryCache implements CacheDB {
  #cache: Map<string, CacheFile> = new Map();

  async get(url: string): Promise<CacheFile | null> {
    return this.#cache.get(url) ?? null;
  }

  async put(file: CacheFile): Promise<void> {
    this.#cache.set(file.url, file);
  }
}

/** A cache that stores responses in IndexedDB. */
class Cache {
  private _db: CacheDB;

  constructor(name: string) {
    if (globalThis.indexedDB) {
      this._db = new IndexedDB(name);
    } else {
      // todo: use fs cache for nodejs/bun/deno
      this._db = new MemoryCache();
    }
  }

  async fetch(url: string | URL): Promise<Response> {
    url = toURL(url);
    const storedRes = await this.query(url);
    if (storedRes) {
      return storedRes;
    }
    const res = await fetch(url);
    if (res.ok) {
      const file: CacheFile = {
        url: url.href,
        content: null,
        ctime: Date.now(),
      };
      if (res.redirected) {
        file.headers = [["location", res.url]];
        this._db.put(file);
      }
      const content = await res.arrayBuffer();
      const headers = [...res.headers.entries()].filter(([k]) =>
        ["cache-control", "content-type", "content-length", "x-typescript-types"].includes(k)
      );
      file.url = res.url;
      file.headers = headers;
      file.content = content;
      this._db.put(file);
      const resp = new Response(content, { headers });
      defineProperty(resp, "url", res.url);
      defineProperty(resp, "redirected", res.redirected);
      return resp;
    }
    return res;
  }

  async query(key: string | URL): Promise<Response | null> {
    const url = toURL(key).href;
    const file = await this._db.get(url);
    if (file && file.headers) {
      const headers = new Headers(file.headers);
      if (headers.has("location")) {
        const redirectedUrl = headers.get("location")!;
        const res = await this.query(redirectedUrl);
        if (res) {
          defineProperty(res, "redirected", true);
        }
        return res;
      }
      const res = new Response(file.content, { headers });
      defineProperty(res, "url", url);
      return res;
    }
    return null;
  }
}

export const cache = new Cache("modern-monaco-cache");
export default cache;
