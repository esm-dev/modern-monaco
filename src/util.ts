// global text encoder and decoder
const enc = new TextEncoder();
const dec = new TextDecoder();

export function createPersistTask(persist: () => void | Promise<void>, delay = 500) {
  let timer: number | null = null;
  const askToExit = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = true;
  };
  return () => {
    if (timer !== null) {
      return;
    }
    globalThis.addEventListener("beforeunload", askToExit);
    timer = setTimeout(async () => {
      timer = null;
      await persist();
      globalThis.removeEventListener("beforeunload", askToExit);
    }, delay);
  };
}

export function createProxy(obj: object, onChange: () => void) {
  let filled = false;
  const proxy = new Proxy(Object.create(null), {
    get(target, key) {
      return Reflect.get(target, key);
    },
    set(target, key, value) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        // don't proxy view state of monaco editor
        if (!value.viewState) {
          value = createProxy(value, onChange);
        }
      }
      const ok = Reflect.set(target, key, value);
      if (ok && filled) {
        onChange();
      }
      return ok;
    },
  }) as Record<string, any>;
  for (const [key, value] of Object.entries(obj)) {
    proxy[key] = value;
  }
  filled = true;
  return proxy;
}

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
export function isObject(v: unknown): v is Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v);
}
