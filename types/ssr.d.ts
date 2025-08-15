import type monacoNS from "./monaco.d.ts";
import type { ShikiInitOptions } from "./index.d.ts";

export type RenderInput = string | { filename: string; code: string; version?: number };

export interface RenderOptions extends monacoNS.editor.IStandaloneEditorConstructionOptions {
  fontDigitWidth?: number;
  userAgent?: string;
  shiki?: ShikiInitOptions;
}

export function renderToString(code: RenderInput, options: RenderOptions): Promise<string>;
export function renderToWebComponent(code: RenderInput, options: RenderOptions): Promise<string>;
