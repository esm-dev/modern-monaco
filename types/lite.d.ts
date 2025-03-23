import type { LSPProvider } from "./lsp.d.ts";
export function registerLSPProvider(lang: string, provider: LSPProvider): void;
export function registerSyntax(...syntaxes: { name: string; scopeName: string }[]): void;
export * from "./index";
