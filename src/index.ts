import { builtinLSPProviders } from "./lsp/index.ts";
import { syntaxes } from "./syntaxes/index.ts";

// ! external modules, don't remove the `.js` extension
import { registerLSPProvider, registerSyntax } from "./lite.js";
export * from "./lite.js";

// register built-in LSP providers
for (const [lang, provider] of Object.entries(builtinLSPProviders)) {
  registerLSPProvider(lang, provider);
}

// register built-in syntaxes
registerSyntax(...syntaxes);
