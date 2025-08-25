import type { TextmateGrammar, TextmateTheme } from "./index.d.ts";
import type { LSPProvider } from "./lsp.d.ts";

export function registerSyntax(...syntaxes: TextmateGrammar[]): void;
export function registerTheme(theme: TextmateTheme): void;
export function registerLSPProvider(lang: string, provider: LSPProvider): void;
export * from "./index";
