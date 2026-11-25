// ! external modules, don't remove the `.js` extension
import { setDefaultWasmLoader } from "../shiki.js";

setDefaultWasmLoader(async () => {
  // @ts-expect-error `node:fs/promises` is available in Node.js, Bun, and Deno
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL("../onig.wasm", import.meta.url));
});

export * from "./ssr.ts";
