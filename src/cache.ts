import { defineProperty, openVFSiDB, toUrl, waitIDBRequest } from "./util.js";

interface CacheFile {
  url: string;
  content: ArrayBuffer | null;
  ctime: number;
  headers?: [string, string][];
}

/** A simple cache for fetch requests using IndexedDB. */
class Cache {
  private _db: Promise<IDBDatabase> | IDBDatabase | null = null;

  constructor(cacheName = "monaco-cache") {
    if (globalThis.indexedDB) {
      this._db = openVFSiDB(cacheName).then((db) => this._db = db);
    }
  }

  async fetch(url: string | URL): Promise<Response> {
    url = toUrl(url);
    const storedRes = await this.query(url);
    if (storedRes) {
      return storedRes;
    }
    const res = await fetch(url);
    if (res.ok && this._db) {
      const db = await this._db;
      const file: CacheFile = {
        url: url.href,
        content: null,
        headers: [],
        ctime: Date.now(),
      };
      if (res.redirected) {
        const tx = db.transaction("files", "readwrite").objectStore("files");
        file.headers.push(["location", res.url]);
        await waitIDBRequest<CacheFile>(tx.put(file));
      }
      const content = await res.arrayBuffer();
      const headers = [...res.headers.entries()].filter(([k]) => ["cache-control", "content-type", "content-length", "x-typescript-types"].includes(k));
      const tx = db.transaction("files", "readwrite").objectStore("files");
      file.url = res.url;
      file.headers = headers;
      file.content = content;
      await waitIDBRequest<CacheFile>(tx.put(file));
      const resp = new Response(content, { headers });
      defineProperty(resp, "url", res.url);
      defineProperty(resp, "redirected", res.redirected);
      return resp;
    }
    return res;
  }

  async query(key: string | URL): Promise<Response | null> {
    if (!this._db) {
      return null;
    }
    const url = toUrl(key).href;
    const db = await this._db;
    const tx = db.transaction("files", "readonly").objectStore("files");
    const ret = await waitIDBRequest<CacheFile>(tx.get(url));
    if (ret && ret.headers) {
      const headers = new Headers(ret.headers);
      if (headers.has("location")) {
        const redirectedUrl = headers.get("location");
        const res = await this.fetch(redirectedUrl);
        defineProperty(res, "redirected", true);
        return res;
      }
      const res = new Response(ret.content, { headers });
      defineProperty(res, "url", url);
      return res;
    }
    return null;
  }
}

export const cache = new Cache();
export default cache;
