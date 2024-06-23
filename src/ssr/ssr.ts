import type { RenderOptions } from "../render.ts";
import type { Highlighter } from "../shiki.ts";

// ! external module, don't remove the `.js` extension
import { getLanguageIdFromPath, initShiki } from "../shiki.js";
import { render } from "../shiki.js";

let ssrHighlighter: Highlighter | Promise<Highlighter> | undefined;

/** Initialize a highlighter instance for rendering. */
async function initRenderHighlighter(options: RenderOptions): Promise<Highlighter> {
  const highlighter = await (ssrHighlighter ?? (ssrHighlighter = initShiki(options.shiki)));
  const { filename, language, theme } = options;
  const promises: Promise<void>[] = [];
  if (language || filename) {
    const languageId = language ?? getLanguageIdFromPath(filename);
    if (!highlighter.getLoadedLanguages().includes(languageId)) {
      console.info(`[esm-monaco] Loading garmmar '${languageId}' from esm.sh ...`);
      promises.push(highlighter.loadLanguageFromCDN(languageId));
    }
  }
  if (theme) {
    if (!highlighter.getLoadedThemes().includes(theme)) {
      console.info(`[esm-monaco] Loading theme '${theme}' from esm.sh ...`);
      promises.push(highlighter.loadThemeFromCDN(theme));
    }
  }
  if (promises.length > 0) {
    await Promise.all(promises);
  }
  return highlighter;
}

/** Render a read-only(mock) editor in HTML string. */
export async function renderToString(options: RenderOptions): Promise<string> {
  const highlighter = await initRenderHighlighter(options);
  return render(highlighter, options);
}

/** Render a `<monaco-editor>` component in HTML string. */
export async function renderToWebComponent(options: RenderOptions): Promise<string> {
  const prerender = await renderToString(options);
  return (
    "<monaco-editor>"
    + "<script type=\"application/json\" class=\"monaco-editor-options\">"
    + JSON.stringify(options)
    + "</script>"
    + "<div class=\"monaco-editor-prerender\" style=\"width:100%;height:100%;\">"
    + prerender
    + "</div>"
    + "</monaco-editor>"
  );
}
