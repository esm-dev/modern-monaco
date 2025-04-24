// ! external modules, don't remove the `.js` extension
import { setDefaultWasmLoader } from "../shiki.js";

// cloudflare worker doesn't allow to import wasm module from binary
// let's use `import()` to load the wasm module
// @ts-expect-error the 'onig.wasm' is created at build time
setDefaultWasmLoader(import("../onig.wasm"));

export * from "./ssr.ts";
