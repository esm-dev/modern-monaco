import type { editor } from "monaco-editor-core";
import type { HighlighterCore } from "@shikijs/core";

const DEFAULT_WINDOWS_FONT_FAMILY = "Consolas, 'Courier New', monospace";
const DEFAULT_MAC_FONT_FAMILY = "Menlo, Monaco, 'Courier New', monospace";
const DEFAULT_LINUX_FONT_FAMILY = "'Droid Sans Mono', 'monospace', monospace";
const LINE_NUMBERS_COLOR = "rgba(222, 220, 213, 0.31)";
const MINIMUM_LINE_HEIGHT = 8;
const MINIMUM_MAX_DIGIT_WIDTH = 5;
const RENDER_MAX_LINES = 10000;

export interface RenderOptions extends editor.IStandaloneEditorConstructionOptions {
  lang: string;
  code: string;
  filename?: string;
  theme?: string;
  userAgent?: string;
  fontMaxDigitWidth?: number;
}

/** Renders a mock monaco editor. */
export function renderMockEditor(
  highlighter: HighlighterCore,
  options: RenderOptions,
): string {
  // non-browser environment
  if (!globalThis.document?.createElement) {
    if (!options.userAgent) {
      throw new Error(
        "`userAgent` option is required in non-browser environment",
      );
    }
    if (!options.fontMaxDigitWidth) {
      throw new Error(
        "`fontMaxDigitWidth` option is required in non-browser environment",
      );
    }
  }

  const userAgent = options.userAgent ?? globalThis.navigator?.userAgent ?? "";
  const isMacintosh = userAgent.includes("Macintosh");
  const isLinux = userAgent.includes("Linux");
  const GOLDEN_LINE_HEIGHT_RATIO = isMacintosh ? 1.5 : 1.35;
  const EDITOR_FONT_DEFAULTS = {
    fontFamily: isMacintosh
      ? DEFAULT_MAC_FONT_FAMILY
      : isLinux
      ? DEFAULT_LINUX_FONT_FAMILY
      : DEFAULT_WINDOWS_FONT_FAMILY,
    fontWeight: "normal",
    fontSize: isMacintosh ? 12 : 14,
    lineHeight: 0,
    letterSpacing: 0,
  };
  const {
    lang,
    code,
    padding,
    fontMaxDigitWidth,
    fontWeight = EDITOR_FONT_DEFAULTS.fontWeight,
    fontSize = EDITOR_FONT_DEFAULTS.fontSize,
    lineHeight = 0,
    letterSpacing = EDITOR_FONT_DEFAULTS.letterSpacing,
    lineNumbersMinChars = 5,
    lineDecorationsWidth = 10,
  } = options;
  const fontLigatures = options.fontLigatures && options.fontLigatures !== "false" ? "1" : "0";
  const fontVariations = options.fontVariations && options.fontVariations !== "false" && /^\d+$/.test(fontWeight);
  const fontFamily = [
    options.fontFamily ? normalizeFontFamily(options.fontFamily) : null,
    EDITOR_FONT_DEFAULTS.fontFamily,
  ].filter(Boolean).join(", ");

  let computedlineHeight = lineHeight || fontSize * GOLDEN_LINE_HEIGHT_RATIO;
  if (computedlineHeight < MINIMUM_LINE_HEIGHT) {
    computedlineHeight = computedlineHeight * fontSize;
  }

  const lines = code.split("\n");
  const lineNumbers = Array.from(
    { length: Math.min(lines.length, RENDER_MAX_LINES) },
    (_, i) => `<div>${i + 1}</div>`,
  );
  const maxDigitWidth = Math.max(
    fontMaxDigitWidth ??
      getMaxDigitWidth([fontWeight, fontSize + "px", fontFamily].join(" ")),
    MINIMUM_MAX_DIGIT_WIDTH,
  );
  const lineNumbersWidth = Math.round(
    Math.max(lineNumbersMinChars, String(lines.length).length) * maxDigitWidth,
  );
  const decorationsWidth = Number(lineDecorationsWidth) + 16;
  const html = highlighter.codeToHtml(lines.splice(0, RENDER_MAX_LINES).join("\n"), {
    lang,
    theme: options.theme ?? highlighter.getLoadedThemes()[0],
  });
  const styleIndex = html.indexOf('style="') + 7;
  const style = [
    "display:flex",
    "width:100%",
    "height:100%",
    "overflow-x:auto",
    "overflow-y:auto",
    "margin:0",
    "padding:0",
    "font-family:'SF Mono',Monaco,Menlo,Consolas,'Ubuntu Mono','Liberation Mono','DejaVu Sans Mono','Courier New',monospace",
    `font-feature-settings:'liga' ${fontLigatures}, 'calt' ${fontLigatures}`,
    "font-variation-settings:" + (fontVariations ? "'wght' " + Number(fontWeight) : "normal"),
    "-webkit-text-size-adjust:100%",
  ];
  const lineStyle = [
    "margin:0",
    "padding:0",
    `font-family:${fontFamily}`,
    `font-weight:${fontWeight}`,
    `font-size:${fontSize}px`,
    `line-height: ${computedlineHeight}px`,
    `letter-spacing: ${letterSpacing}px`,
  ];
  const lineNumbersStyle = [
    ...lineStyle,
    "flex-shrink:0",
    "text-align:right",
    "user-select:none",
    `color:${LINE_NUMBERS_COLOR}`,
    `width:${lineNumbersWidth}px`,
  ];
  const clasName = `mock-monaco-editor-${hashCode(lineNumbers.join(";")).toString(36)}`;
  const shikiStyle = html.slice(styleIndex, html.indexOf('"', styleIndex));
  const finHtml = html.slice(0, styleIndex) + lineStyle.join(";") + ";" + html.slice(styleIndex);
  const css = [`.${clasName} code {${lineStyle.join(";")}}`];
  const addPadding = (padding: number, side: string) => {
    const style = `{display:block;height:${padding}px;content:' '}`;
    css.push(`.${clasName} .line-numbers:${side}, .${clasName} .shiki:${side} ${style}`);
  };
  style.push(shikiStyle);
  if (padding?.top) {
    addPadding(padding.top, "before");
  }
  if (padding?.bottom) {
    addPadding(padding.bottom, "after");
  }
  return `<div class="mock-monaco-editor ${clasName}" style="${style.join(";")}">
<style>${css.join('')}</style>
<div class="line-numbers" style="${lineNumbersStyle.join(";")}">
${lineNumbers.join("")}
</div>
<div style="flex-shrink:0;width:${decorationsWidth}px"></div>
${finHtml}
</div>`;
}

// Get the maximum width of a digit in the given font.
// https://stackoverflow.com/questions/118241/calculate-text-width-with-javascript
function getMaxDigitWidth(font: string) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const widths: number[] = [];
  context.font = font;
  for (let i = 0; i < 10; i++) {
    const metrics = context.measureText(i.toString());
    widths.push(metrics.width);
  }
  return Math.max(...widths);
}

/** Hash code for strings */
export const hashCode = (s: string) => [...s].reduce((hash, c) => (Math.imul(31, hash) + c.charCodeAt(0)) | 0, 0);

function normalizeFontFamily(fontFamily: string) {
  return fontFamily
    .split(",")
    .map((f) => f.replace(/['"]+/g, "").trim())
    .filter(Boolean)
    .map((f) => (f.includes(" ") ? `'${f}'` : f))
    .join(", ");
}
