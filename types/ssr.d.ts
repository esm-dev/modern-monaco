import type monacoNS from "./monaco.d.ts";
import type { ShikiInitOptions } from "./index.d.ts";

export interface RenderOptions extends monacoNS.editor.IStandaloneEditorConstructionOptions {
  code: string;
  filename?: string;
  language?: string;
  userAgent?: string;
  fontAspectRatio?: number;
  shiki?: ShikiInitOptions;
}

export function renderToString(options: RenderOptions): Promise<string>;
export function renderToWebComponent(options: RenderOptions): Promise<string>;
