export function registerLSPProvider(lang: string, provider: import("./lsp.d.ts").LSPProvider): void;
export function registerSyntax(...syntaxes: import("./index.d.ts").TextmateGrammar[]): void;
export function registerTheme(theme: import("./index.d.ts").TextmateTheme): void;
export * from "./index";
