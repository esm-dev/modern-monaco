// ! external module, don't remove the `.js` extension
import { setDefaultWasmLoader } from "../shiki.js";

// @ts-expect-error the 'onig.wasm' is created at build time
setDefaultWasmLoader(import("../onig.wasm"));

export * from "./ssr.ts";
