import type { RenderInput, RenderOptions } from "../render.ts";
import type { Highlighter } from "../shiki.ts";

// ! external modules, don't remove the `.js` extension
import { getLanguageIdFromPath, initShiki } from "../shiki.js";
import { render } from "../shiki.js";

let ssrHighlighter: Highlighter | Promise<Highlighter> | undefined;

/** Render a read-only(mock) editor in HTML string. */
export async function renderToString(input: RenderInput, options?: RenderOptions): Promise<string> {
  const { language, theme, shiki } = options ?? {};
  const filename = typeof input === "string" ? undefined : input.filename;
  const highlighter = await (ssrHighlighter ?? (ssrHighlighter = initShiki(shiki)));
  const promises: Promise<void>[] = [];
  if (theme && !highlighter.getLoadedThemes().includes(theme)) {
    console.info(`[modern-monaco] Loading theme '${theme}' from CDN...`);
    promises.push(highlighter.loadThemeFromCDN(theme));
  }
  if (language || filename) {
    const languageId = language ?? getLanguageIdFromPath(filename!);
    if (languageId && !highlighter.getLoadedLanguages().includes(languageId)) {
      console.info(
        `[modern-monaco] Loading garmmar '${languageId}' from CDN...`,
      );
      promises.push(highlighter.loadGrammarFromCDN(languageId));
    }
  }
  if (promises.length > 0) {
    await Promise.all(promises);
  }
  return render(highlighter, input, options);
}

/** Render a `<monaco-editor>` component in HTML string. */
export async function renderToWebComponent(input: RenderInput, options?: RenderOptions): Promise<string> {
  const prerender = await renderToString(input, options);
  const workspaceName = options?.workspace ? ` workspace="${options.workspace}"` : "";

  return (
    "<monaco-editor" + workspaceName + ">"
    + '<script type="application/json" class="monaco-editor-options">'
    + JSON.stringify([input, options]).replaceAll("/", "\\/")
    + "</script>"
    + '<div class="monaco-editor-prerender" style="width:100%;height:100%;">'
    + prerender
    + "</div>"
    + "</monaco-editor>"
  );
}
