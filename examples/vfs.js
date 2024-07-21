// GET /assets/vfs.js

import { VFS } from "/esm-monaco/vfs.js";

const importMap = {
  imports: {
    "@jsxImportSource": "https://esm.sh/react@18.2.0",
    "react": "https://esm.sh/react@18.2.0",
    "react-dom/": "https://esm.sh/react-dom@18.2.0/",
  },
};

export const files = {
  "log.d.ts": [
    "/** log a message. */",
    "declare function log(message:string): void;",
  ].join("\n"),
  "greeting.ts": "export const message = \"Hello world!\" as const;",
  "index.html": [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <title>React App</title>",
    "  <link rel=\"stylesheet\" href=\"./style.css\">",
    "  \<script type=\"importmap\">",
    JSON.stringify(importMap, null, 2).split("\n").map((line) => "  " + line).join("\n"),
    "  <\/script>",
    "</head>",
    "<body>",
    "  <div id=\"root\"></div>",
    "  <script type=\"module\" src=\"./main.jsx\"><\/script>",
    "</body>",
    "</html>",
  ].join("\n"),
  "style.css": [
    "h1 {",
    "  font-style: italic;",
    "}",
  ].join("\n"),
  "App.tsx": $APP_TSX,
  "main.jsx": [
    "import { createRoot } from \"react-dom/client\"",
    "import App from \"./App.tsx\"",
    "",
    "const root = createRoot(document.getElementById(\"root\"))",
    "root.render(<App />)",
  ].join("\n"),
  "import_map.json": JSON.stringify(importMap, null, 2),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        types: [
          "log.d.ts",
          "https://raw.githubusercontent.com/vitejs/vite/main/packages/vite/types/importMeta.d.ts",
        ],
      },
    },
    null,
    2,
  ),
};

export const vfs = new VFS({
  scope: "test",
  initial: files,
  defaultFile: 'index.html',
  history: "browserHistory"
});
