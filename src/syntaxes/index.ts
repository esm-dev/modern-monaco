import html from "tm-grammars/grammars/html.json";
import css from "tm-grammars/grammars/css.json";
import javascript from "tm-grammars/grammars/javascript.json";
import typescript from "tm-grammars/grammars/typescript.json";
import tsx from "tm-grammars/grammars/tsx.json";
import json from "tm-grammars/grammars/json.json";
import htmlJsonScript from "./(html)json-script-tag.json";
import inlineHtml from "./(js)inline-html.json";
import inlineCSS from "./(js)inline-css.json";

export const syntaxes = [
  html,
  css,
  javascript,
  typescript,
  tsx,
  json,
  htmlJsonScript,
  inlineHtml,
  inlineCSS,
];
