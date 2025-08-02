> [!WARNING]
> **This project is currently under active development, the API may change at any time. Use at your own risk.**
> Please report any issues or feature requests on the [issues](https://github.com/esm-dev/modern-monaco/issues) page.

# Modern Monaco

Meeting the modern version of [Monaco Editor](https://www.npmjs.com/package/monaco-editor):

- Easy to use, no `MonacoEnvironment` setup and web-worker/css loader needed.
- Using [Shiki](https://shiki.style) for syntax highlighting with tons of grammars and themes.
- Lazy loading: pre-highlighting code with Shiki while loading `monaco-editor-core` in background.
- Support **server-side rendering(SSR)**.
- Workspace (edit history, file system provider, persist protocol, etc).
- Automatically loading `.d.ts` from [esm.sh](https://esm.sh) CDN for type checking.
- Using [import maps](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) for resolving **bare specifier** imports in JavaScript/TypeScript.
- VSCode `window` APIs like `showInputBox`, `showQuickPick`, etc.
- Embedded languages(importmap/CSS/JavaScript) in HTML.
- Inline `html` and `css` in JavaScript/TypeScript.
- Auto-closing HTML/JSX tags.

## Installation

You can install `modern-monaco` from NPM:

```bash
npm i modern-monaco typescript
```

> [!Note]
> The `typescript` package is required by JavaScript/TypeScript LSP worker. We recommend `typescript@5.5.x` or later.

or import it from [esm.sh](https://esm.sh/) CDN in browser without build step:

```js
import * from "https://esm.sh/modern-monaco"
```

## Usage

`modern-monaco` provides three modes to create a browser-based code editor:

- **Lazy**: pre-highlight code with Shiki while loading the `editor-core.js` in the background.
- **SSR**: render a mock editor on the server side, and hydrate it on the client side.
- **Manual**: create a monaco editor instance manually.

### Lazy Mode

[monaco-editor](https://www.npmjs.com/package/monaco-editor) is a large package with extra CSS/Worker modules, and needs the `MonacoEnvironment` setup for language service support. `modern-monaco` provides a lazy but smart way to load the editor modules on demand.

By pre-highlighting code with Shiki while loading editor modules in the background, `modern-monaco` can reduce the loading screen time.

```html
<monaco-editor></monaco-editor>

<script type="module">
  import { lazy, Workspace } from "modern-monaco";

  // create a workspace with initial files
  const workspace = new Workspace({
    initialFiles: {
      "index.html": `<html><head><title>Hello, world!</title></head><body><script src="main.js"></script></body></html>`,
      "main.js": `console.log("Hello, world!")`
    },
    entryFile: "index.html",
  });

  // initialize the editor lazily
  lazy({ workspace });
</script>
```

### SSR Mode

SSR mode returns an instant pre-rendered editor on the server side, and hydrate it on the client side.

```js
import { renderToWebComponent } from "modern-monaco/ssr";

export default {
  async fetch(req) {
    const ssrOut = await renderToWebComponent(
      `console.log("Hello, world!")`,
      {
        theme: "OneDark-Pro",
        language: "javascript",
        userAgent: req.headers.get("user-agent"), // detect default font for different platforms
      },
    );
    return new Response(
      html`
      ${ssrOut}
      <script type="module">
        import { hydrate } from "https://esm.sh/modern-monaco";
        // hydrate the editor
        hydrate();
      </script>
    `,
      { headers: { "Content-Type": "text/html" } },
    );
  },
};
```

### Manual Mode

You can also create a [monaco editor](https://microsoft.github.io/monaco-editor/docs.html) instance manually.

```html
<div id="editor"></div>

<script type="module">
  import { init } from "modern-monaco";

  // load monaco-editor-core.js
  const monaco = await init();

  // create a monaco editor instance
  const editor = monaco.editor.create(document.getElementById("editor"));

  // create and attach a model to the editor
  editor.setModel(monaco.editor.createModel(`console.log("Hello, world!")`, "javascript"));
</script>
```

## Using Workspace

`modern-monaco` provides VSCode-like workspace features, like edit history, file system provider, etc.

```js
import { lazy, Workspace } from "modern-monaco";

// 1. create a workspace with initial files
const workspace = new Workspace({
  /** the name of the workspace, used for project isolation, default is "default". */
  name: "project-name",
  /** initial files in the workspace. */
  initialFiles: {
    "index.html": `<html><head><title>Hello, world!</title></head><body><script src="main.js"></script></body></html>`,
    "main.js": `console.log("Hello, world!")`,
  },
  /** file to open when the editor is loaded for the first time. */
  entryFile: "index.html",
});

// 2. use the workspace in lazy mode
lazy({ workspace });

// 3. open a file in the workspace
workspace.openTextDocument("main.js");
```

### Adding `tsconfig.json`

You can add a `tsconfig.json` file to configure the TypeScript compiler options for the TypeScript language service.

```js
const tsconfig = {
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
  },
};
const workspace = new Workspace({
  initialFiles: {
    "tsconfig.json": JSON.stringify(tsconfig, null, 2),
  },
});
```

### Using Import Maps

`modern-monaco` uses [import maps](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) to resolve **bare specifier** imports in JavaScript/TypeScript. By default, `modern-monaco` detects the `importmap` from the root `index.html` in the workspace.

```js
const indexHtml = html`<!DOCTYPE html>
<html>
  <head>
    <script type="importmap">
      {
        "imports": {
          "react": "https://esm.sh/react@18",
          "react-dom/": "https://esm.sh/react-dom@18/"
        }
      }
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="app.tsx"></script>
  </body>
</html>
`;
const appTsx = `import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")).render(<div>Hello, world!</div>);
`;

const workspace = new Workspace({
  initialFiles: {
    "index.html": indexHtml,
    "app.tsx": appTsx,
  },
});
```

You can also provide an importmap object as the `lsp.typescript.importMap` option in the `lazy`, `init`, or `hydrate` function.

```js
lazy({
  lsp: {
    typescript: {
      importMap: {
        "react": "https://esm.sh/react@18",
        "react-dom/": "https://esm.sh/react-dom@18/",
      },
    },
  },
});
```

> [!Note]
> By default, `modern-monaco` uses `react` or `preact` in the `importmap` script as the `jsxImportSource` option for typescript worker.
> To use a custom `jsxImportSource` option, add `@jsxRuntime` specifier in the `importmap` script.

## Editor Theme & Language Grammars

`modern-monaco` uses [Shiki](https://shiki.style) for syntax highlighting with tons of grammars and themes. By default, it loads themes and grammars from esm.sh on demand.

### Setting the Editor Theme

To set the theme of the editor, you can add a `theme` attribute to the `<monaco-editor>` element.

```html
<monaco-editor theme="OneDark-Pro"></monaco-editor>
```

or set it in the `lazy`, `init`, or `hydrate` function.

```js
lazy({
  theme: "OneDark-Pro",
});
```

> [!Note]
> The theme ID should be one of the [Shiki Themes](https://shiki.style/themes).

`modern-monaco` loads the theme data from the CDN when a theme ID is provided. You can also use a theme from the `tm-themes` package:

```js
import OneDark from "tm-themes/themes/OneDark-Pro.json" with { type: "json" };

lazy({
  theme: OneDark
});
```

### Pre-loading Language Grammars

By default, `modern-monaco` loads language grammars when a specific language mode is attached in the editor. You can also pre-load language grammars by adding the `langs` option to the `lazy`, `init`, or `hydrate` function. The `langs` option is an array of language grammars, which can be a language grammar object, a language ID, or a URL to the language grammar.

```js
import markdown from "tm-grammars/markdown.json" with { type: "json" };

lazy({
  langs: [
    // load language grammars from CDN
    "html",
    "css",
    "javascript",
    "json",

    // load language grammar from a URL
    "https://example.com/grammars/mylang.json",

    // load language grammar from a local file
    "/assets/mylang.json",

    // use `tm-grammars` package without extra http requests, but increases the bundle size
    markdown,

    // dynamically import
    () => import("tm-grammars/markdown.json", { with: { type: "json" } }),

    // hand-crafted language grammar
    {
      name: "mylang",
      scopeName: "source.mylang",
      patterns: [/* ... */],
    },
  ],
  // the CDN for loading language grammars and themes, default is "https://esm.sh"
  tmDownloadCDN: "https://unpkg.com",
});
```

## Editor Options

You can set the editor options in the `<monaco-editor>` element as attributes. The editor options are the same as the [`editor.EditorOptions`](https://microsoft.github.io/monaco-editor/docs.html#variables/editor.EditorOptions.html).

```html
<monaco-editor
  theme="OneDark-Pro"
  fontFamily="Geist Mono"
  fontSize="16"
></monaco-editor>
```

For SSR mode, you can set the editor options in the `renderToWebComponent` function.

```js
import { renderToWebComponent } from "modern-monaco/ssr";

const html = await renderToWebComponent(
  `console.log("Hello, world!")`,
  {
    theme: "OneDark-Pro",
    language: "javascript",
    fontFamily: "Geist Mono",
    fontSize: 16,
  },
);
```

For manual mode, check [here](https://microsoft.github.io/monaco-editor/docs.html#functions/editor.create.html) for more details.

## Language Server Protocol (LSP)

`modern-monaco` by default supports full LSP features for the following languages:

- **HTML**
- **CSS/SCSS/LESS**
- **JavaScript/TypeScript**
- **JSON**

Plus, `modern-monaco` also supports features like:

- **File System Provider for import completions**
- **Embedded languages in HTML**
- **Inline `html` and `css` in JavaScript/TypeScript.**
- **Auto-closing HTML/JSX tags**

> [!Note]
> You don't need to set the `MonacoEnvironment.getWorker` for LSP support.
> `modern-monaco` will automatically load the required LSP workers.

### LSP language configuration

You can configure built-in LSPs in the `lazy`, `init`, or `hydrate` function.

```js
lazy({
  // configure LSP for each language
  lsp: {
    html: {/* ... */},
    json: {/* ... */},
    typescript: {/* ... */},
  },
});
```

The `LSPLanguageConfig` interface is defined as:

```ts
export interface LSPLanguageConfig {
  html?: {
    attributeDefaultValue?: "empty" | "singlequotes" | "doublequotes";
    customTags?: ITagData[];
    hideAutoCompleteProposals?: boolean;
  };
  css?: {};
  json?: {
    /** JSON schemas for JSON language service. */
    schemas?: JSONSchemaSource[];
  };
  typescript?: {
    /** The compiler options. */
    compilerOptions?: ts.CompilerOptions;
    /** The global import map. */
    importMap?: ImportMap;
    /** The version of TypeScript from the CDN. Default: ">= 5.0.0" */
    tsVersion?: string;
  };
}
```

### Using `core` module

`modern-monaco` includes built-in grammars and LSP providers for HTML, CSS, JavaScript/TypeScript, and JSON. If you don't need these features, you can use the `modern-monaco/core` sub-module to reduce the bundle size.

```js
import { lazy } from "modern-monaco/core";

lazy();
```
