// ! external modules, don't remove the `.js` extension
import { setDefaultWasmLoader } from "../shiki.js";
import { getWasmInstance } from "../shiki-wasm.js";

setDefaultWasmLoader(getWasmInstance);

export * from "./ssr.ts";
