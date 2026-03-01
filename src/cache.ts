// ! external modules, don't remove the `.js` extension
import { defineProperty, normalizeURL, openIDB, promisifyIDBRequest } from "./util.js";

interface CacheFile {
  url: string;
  content: ArrayBuffer | null;
  createdAt: number;
  expiresAt: number;
  headers: [string, string][];
}

interface CacheDB {
  get(url: string): Promise<CacheFile | null>;
  put(file: CacheFile): Promise<void>;
  delete(url: string): Promise<void>;
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

  async delete(url: string): Promise<void> {
    const db = await this.#db;
    const tx = db.transaction("store", "readwrite").objectStore("store");
    await promisifyIDBRequest<void>(tx.delete(url));
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

  async delete(url: string): Promise<void> {
    this.#cache.delete(url);
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
    const storedRes = await this.query(url);
    if (storedRes) {
      return storedRes;
    }

    const res = await fetch(url);
    if (!res.ok || !res.headers.has("cache-control")) {
      return res;
    }

    const cacheControl = res.headers.get("cache-control")!;
    const maxAgeStr = cacheControl.match(/max-age=(\d+)/)?.[1];
    if (!maxAgeStr) {
      return res;
    }
    const maxAge = parseInt(maxAgeStr);
    if (isNaN(maxAge) || maxAge <= 0) {
      return res;
    }
    const createdAt = Date.now();
    const expiresAt = createdAt + maxAge * 1000;
    const file: CacheFile = {
      url: res.url,
      content: null,
      createdAt,
      expiresAt,
      headers: [],
    };
    if (res.redirected) {
      // cache the redirected response as well
      await this._db.put({
        ...file,
        url: url instanceof URL ? url.href : url, // raw url
        headers: [["location", res.url]],
      });
    }
    for (const header of ["content-type", "x-typescript-types"]) {
      if (res.headers.has(header)) {
        file.headers.push([header, res.headers.get(header)!]);
      }
    }
    file.content = await res.arrayBuffer();
    await this._db.put(file);
    const resp = new Response(file.content, { headers: file.headers });
    defineProperty(resp, "url", res.url);
    defineProperty(resp, "redirected", res.redirected);
    return resp;
  }

  async query(key: string | URL): Promise<Response | null> {
    const url = normalizeURL(key).href;
    const file = await this._db.get(url);
    if (file) {
      if (file.expiresAt < Date.now()) {
        await this._db.delete(url);
        return null;
      }
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
