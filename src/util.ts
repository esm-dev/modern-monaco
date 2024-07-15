// global text encoder and decoder
const enc = new TextEncoder();
const dec = new TextDecoder();
const on = globalThis.addEventListener.bind(globalThis);
const off = globalThis.removeEventListener.bind(globalThis);

/** Define property with value. */
export function defineProperty(obj: any, prop: string, value: any) {
  Object.defineProperty(obj, prop, { value });
}

/** Convert string to URL. */
export function toUrl(name: string | URL) {
  return typeof name === "string" ? new URL(name, "file:///") : name;
}

/** Convert string to Uint8Array. */
export function encode(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? enc.encode(data) : data;
}

/** Convert Uint8Array to string. */
export function decode(data: string | Uint8Array) {
  return data instanceof Uint8Array ? dec.decode(data) : data;
}

/** Check if the value is an object. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && v.constructor === Object;
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
    on("beforeunload", askToExit);
    timer = setTimeout(async () => {
      timer = null;
      await persist();
      off("beforeunload", askToExit);
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
    on("beforeunload", persist);
    timer = setTimeout(() => {
      timer = null;
      off("beforeunload", persist);
      persist();
    }, delay);
  };
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

/** promisify the given IDBRequest. */
export function promisifyIDBRequest<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
