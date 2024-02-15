import type { editor } from "monaco-editor-core";
import type { HighlighterCore } from "@shikijs/core";

const DEFAULT_WINDOWS_FONT_FAMILY = "Consolas, 'Courier New', monospace";
const DEFAULT_MAC_FONT_FAMILY = "Menlo, Monaco, 'Courier New', monospace";
const DEFAULT_LINUX_FONT_FAMILY = "'Droid Sans Mono', 'monospace', monospace";
const LINE_NUMBERS_COLOR = "rgba(222, 220, 213, 0.31)";
const MINIMUM_LINE_HEIGHT = 8;
const MINIMUM_MAX_DIGIT_WIDTH = 5;

export interface RenderOptions extends editor.IStandaloneEditorConstructionOptions {
  code: string;
  lang?: string;
  filename?: string;
  theme?: string;
  userAgent?: string;
  fontDigitWidth?: number;
}

/** Renders a mock monaco editor. */
export function render(
  highlighter: HighlighterCore,
  options: RenderOptions,
): string {
  const isBrowser = typeof globalThis.document?.createElement === "function";
  if (!options.userAgent && !isBrowser) {
    throw new Error(
      "`userAgent` option is required in non-browser environment",
    );
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
    fontWeight = EDITOR_FONT_DEFAULTS.fontWeight,
    fontSize = EDITOR_FONT_DEFAULTS.fontSize,
    lineHeight = 0,
    letterSpacing = EDITOR_FONT_DEFAULTS.letterSpacing,
    lineNumbers = "on",
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

  let lineNumbersHtml = "";
  if (lineNumbers !== "off") {
    let fontDigitWidth = options.fontDigitWidth;
    if (!fontDigitWidth && !isBrowser) {
      fontDigitWidth = options.fontDigitWidth = (fontSize * 60) / 100;
    }
    const lines = countLines(code);
    const lineNumbersElements = Array.from(
      { length: lines },
      (_, i) => `<code>${i + 1}</code>`,
    );
    const maxDigitWidth = Math.max(
      fontDigitWidth ?? getDigitWidth([fontWeight, fontSize + "px", fontFamily].join(" ")),
      MINIMUM_MAX_DIGIT_WIDTH,
    );
    const lineNumbersWidth = Math.round(
      Math.max(lineNumbersMinChars, String(lines).length) * maxDigitWidth,
    );
    const lineNumbersStyle = [
      "display:flex",
      "flex-direction:column",
      "flex-shrink:0",
      "text-align:right",
      "user-select:none",
      `color:${LINE_NUMBERS_COLOR}`,
      `width:${lineNumbersWidth}px`,
    ];
    lineNumbersHtml = [
      `<div class="line-numbers" style="${lineNumbersStyle.join(";")}">`,
      ...lineNumbersElements,
      "</div>",
    ].join("");
  }

  const decorationsWidth = Number(lineDecorationsWidth) + 16;
  const html = highlighter.codeToHtml(code, {
    lang,
    theme: options.theme ?? highlighter.getLoadedThemes()[0],
  });
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
    `font-variation-settings:${fontVariations ? "'wght' " + Number(fontWeight) : "normal"}`,
    "-webkit-text-size-adjust:100%",
  ];
  const lineStyle = [
    "margin:0",
    "padding:0",
    `font-family:${fontFamily}`,
    `font-weight:${fontWeight}`,
    `font-size:${fontSize}px`,
    `line-height:${computedlineHeight}px`,
    `letter-spacing:${letterSpacing}px`,
  ];
  const clasName = `mock-monaco-editor-${hashCode(lineStyle.join(";")).toString(36)}`;
  const shikiStyleIndex = html.indexOf('style="') + 7;
  const shikiStyle = html.slice(shikiStyleIndex, html.indexOf('"', shikiStyleIndex));
  const finHtml = html.slice(0, shikiStyleIndex) + lineStyle.join(";") + ";" + html.slice(shikiStyleIndex);
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
  return [
    `<div class="mock-monaco-editor ${clasName}" style="${style.join(";")}">`,
    `<style>${css.join("")}</style>`,
    lineNumbersHtml,
    `<div style="flex-shrink:0;width:${decorationsWidth}px"></div>`,
    `${finHtml}`,
    `</div>`,
  ].join("");
}

/** Count the number of lines in the given text. */
function countLines(text: string) {
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    if (char === 10 || (char === 13 && text.charCodeAt(i + 1) !== 10)) {
      n++;
    }
  }
  return n;
}

// Get the width of a digit in the given font.
// https://stackoverflow.com/questions/118241/calculate-text-width-with-javascript
function getDigitWidth(font: string) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const widths: number[] = [];
  context.font = font;
  return context.measureText("0").width;
}

/** Hash code for strings */
function hashCode(s: string) {
  return [...s].reduce((hash, c) => (Math.imul(31, hash) + c.charCodeAt(0)) | 0, 0);
}

/** Normalize font family string */
function normalizeFontFamily(fontFamily: string) {
  return fontFamily
    .split(",")
    .map((f) => f.replace(/['"]+/g, "").trim())
    .filter(Boolean)
    .map((f) => (f.includes(" ") ? `'${f}'` : f))
    .join(", ");
}
