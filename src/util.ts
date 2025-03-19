const enc = /* @__PURE__ */ new TextEncoder();
const dec = /* @__PURE__ */ new TextDecoder();

/** Convert string to Uint8Array. */
export function encode(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? enc.encode(data) : data;
}

/** Convert Uint8Array to string. */
export function decode(data: string | Uint8Array): string {
  return data instanceof Uint8Array ? dec.decode(data) : data;
}

/** Define property with value. */
export function defineProperty(obj: any, prop: string, value: any) {
  Object.defineProperty(obj, prop, { value });
}

/** Convert string to URL. */
export function toURL(uri: string | URL): URL {
  return uri instanceof URL ? uri : new URL(uri, "file:///");
}

/** Convert string to URL. */
export function filenameToURL(filename: string): URL {
  if (filename.startsWith("file://")) {
    filename = filename.slice(7);
  }
  const url = new URL(filename.replace(/[\/\\]+/g, "/"), "file:///");
  if (url.pathname.endsWith("/")) {
    // strip trailing slash
    url.pathname = url.pathname.slice(0, -1);
  }
  url.search = ""; // remove search
  return url;
}

/** Check if the value is a plain object. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && v.constructor === Object;
}

/** Debounce the function call. */
export function debunce(fn: () => void, delay = 500) {
  let timer: number | null = null;
  return () => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, delay);
  };
}

/**
 * Create a task that persists the data to the storage.
 * It will ask the user to confirm before leaving the page if the data is not persisted.
 * @param persist - The function that persists the data.
 * @param delay - The delay in milliseconds before persisting the data. Default is 500ms.
 * @returns The persist trigger function.
 */
export function createPersistTask(persist: () => void | Promise<void>, delay = 500) {
  let timer: number | null = null;
  const askToExit = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    return false;
  };
  return () => {
    if (timer !== null) {
      return;
    }
    addEventListener("beforeunload", askToExit);
    timer = setTimeout(async () => {
      timer = null;
      await persist();
      removeEventListener("beforeunload", askToExit);
    }, delay);
  };
}

/**
 * Create a task that persists the data to the storage synchronously.
 * @param persist - The function that persists the data synchronously.
 * @param delay - The delay in milliseconds before persisting the data. Default is 500ms.
 * @returns The persist trigger function.
 */
export function createSyncPersistTask(persist: () => void, delay = 500) {
  let timer: number | null = null;
  return () => {
    if (timer !== null) {
      return;
    }
    addEventListener("beforeunload", persist);
    timer = setTimeout(() => {
      timer = null;
      removeEventListener("beforeunload", persist);
      persist();
    }, delay);
  };
}

/** Create a proxy object that triggers persist in localStorage when the object is modified. */
export function createPersistStateStorage<T extends object>(storeKey: string, defaultValue?: T): T {
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

/** Create a proxy object that triggers onChange when the object is modified. */
export function createProxy<T extends object>(obj: T, onChange: () => void): T {
  let filled = false;
  const proxy: T = new Proxy(Object.create(null), {
    get(target, key) {
      return Reflect.get(target, key);
    },
    set(target, key, value) {
      if (isPlainObject(value) && !Object.isFrozen(value)) {
        // proxy nested object
        value = createProxy(value, onChange);
      }
      const ok = Reflect.set(target, key, value);
      if (ok && filled) {
        onChange();
      }
      return ok;
    },
  });
  for (const [key, value] of Object.entries(obj)) {
    proxy[key] = value;
  }
  filled = true;
  return proxy;
}

/** Check if browser supports localStorage. */
export function supportLocalStorage() {
  if (globalThis.localStorage) {
    try {
      localStorage.setItem("..", "");
      localStorage.removeItem("..");
      return true;
    } catch {}
  }
  return false;
}

/** promisify the given IDBRequest. */
export function promisifyIDBRequest<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Open the indexedDB with the given name and version. */
export async function openIDB(
  name: string,
  version: number = 1,
  ...stores: { name: string; keyPath: string; onCreate?: (store: IDBObjectStore) => Promise<void> }[]
) {
  const req = indexedDB.open(name, version);
  const promises: Promise<void>[] = [];
  req.onupgradeneeded = () => {
    const db = req.result;
    for (const { name, keyPath, onCreate } of stores) {
      if (!db.objectStoreNames.contains(name)) {
        const store = db.createObjectStore(name, { keyPath });
        if (onCreate) {
          promises.push(onCreate(store));
        }
      }
    }
  };
  const db = await promisifyIDBRequest<IDBDatabase>(req);
  await Promise.all(promises);
  return db;
}

/** open the IDBCursor with the given range and direction. */
export function openIDBCursor(
  store: IDBObjectStore,
  range: IDBKeyRange,
  callback: (cursor: IDBCursorWithValue) => boolean | void,
  direction?: IDBCursorDirection,
) {
  return new Promise<void>((resolve, reject) => {
    const ocr = store.openCursor(range, direction);
    ocr.onsuccess = () => {
      const cursor = ocr.result;
      if (cursor) {
        if (callback(cursor) !== false) {
          cursor.continue();
          return;
        }
      }
      resolve();
    };
    ocr.onerror = () => {
      reject(ocr.error);
    };
  });
}

/** polyfill for `Promise.withResolvers` */
export function promiseWithResolvers<T>() {
  let resolve: (value: T) => void;
  let reject: (reason: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve!, reject: reject! };
}
