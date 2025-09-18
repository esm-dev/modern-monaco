import type * as monacoNS from "./monaco.d.ts";
import type { ShikiInitOptions } from "./index.d.ts";

export type RenderInput = string | { filename: string; code: string; version?: number };

export interface RenderOptions extends Omit<monacoNS.editor.IStandaloneEditorConstructionOptions, "model" | "value"> {
  fontDigitWidth?: number;
  userAgent?: string;
  shiki?: ShikiInitOptions;
  workspace?: string;
}

export function renderToString(code: RenderInput, options: RenderOptions): Promise<string>;
export function renderToWebComponent(code: RenderInput, options: RenderOptions): Promise<string>;
