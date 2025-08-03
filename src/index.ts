import vitesseDark from "tm-themes/themes/vitesse-dark.json" with { type: "json" };
import { builtinLSPProviders } from "./lsp/index.ts";
import { syntaxes } from "./syntaxes/index.ts";

// ! external modules, don't remove the `.js` extension
import { registerLSPProvider, registerSyntax, registerTheme } from "./core.js";
export { errors, hydrate, init, lazy, Workspace } from "./core.js";

// register built-in LSP providers
for (const [lang, provider] of Object.entries(builtinLSPProviders)) {
  registerLSPProvider(lang, provider);
}

// register built-in syntaxes
registerSyntax(...syntaxes);

// register built-in themes
registerTheme(vitesseDark);
