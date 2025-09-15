const importMap = {
  imports: {
    "lodash": "https://esm.sh/lodash@4.17.21",
    "react": "https://esm.sh/react@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
  },
};

const appTsx = `import confetti from "https://esm.sh/canvas-confetti@1.6.0";
import _ from "lodash";
import { useEffect } from "react";
import { message } from "./greeting.ts";

export default function App() {
  useEffect(() => {
    confetti();
    _.times(3, () => console.log(message));
  }, []);

  return (
    <h1>{message}</h1>
  );
}
`

export const files = {
  "src/App.tsx": appTsx,
  "style/style.css": [
    "h1 {",
    "  font-style: italic;",
    "}",
  ].join("\n"),
  "types/log.d.ts": [
    "/** log a message. */",
    "declare function log(message:string): void;",
  ].join("\n"),
  "index.html": [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <title>React App</title>",
    "  <link rel=\"stylesheet\" href=\"./style/style.css\">",
    "  <script type=\"importmap\">",
    JSON.stringify(importMap, null, 2).split("\n").map((line) => "  " + line).join("\n"),
    "  </script>",
    "  <style>",
    "    h1 {",
    "      color: #5eaab5;",
    "    }",
    "  </style>",
    "</head>",
    "<body>",
    "  <div id=\"root\"></div>",
    "  <script type=\"module\">",
    "    import { createElement } from \"react\"",
    "    import { createRoot } from \"react-dom/client\"",
    "    import App from \"./src/App.tsx\"",
    "    const root = createRoot(document.getElementById(\"root\"))",
    "    root.render(createElement(App))",
    "  </script>",
    "</body>",
    "</html>",
  ].join("\n"),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        types: [
          "types/log.d.ts",
          "https://raw.githubusercontent.com/vitejs/vite/main/packages/vite/types/importMeta.d.ts",
        ],
      },
    },
    null,
    2,
  ),
};
