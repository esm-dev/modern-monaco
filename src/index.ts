import vitesseDark from "tm-themes/themes/vitesse-dark.json" with { type: "json" };
import { syntaxes } from "./syntaxes/index.ts";

// ! external modules, don't remove the `.js` extension
import { registerSyntax, registerTheme } from "./core.js";
export { errors, hydrate, init, lazy, Workspace } from "./core.js";

// register built-in syntaxes
for (const syntax of syntaxes) {
  registerSyntax(syntax);
}

// register built-in themes
registerTheme(vitesseDark);

// use builtin LSP providers
Reflect.set(globalThis, "MonacoEnvironment", { useBuiltinLSP: true });
