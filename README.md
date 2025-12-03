> [!WARNING]
> **This project is currently under active development. The API may change at any time. Use at your own risk.**
> Please report any issues or feature requests on the [issues](https://github.com/esm-dev/modern-monaco/issues) page.

# Modern Monaco

Meet the modern version of [Monaco Editor](https://www.npmjs.com/package/monaco-editor):

- Easy to use, no `MonacoEnvironment` setup, web workers, or CSS loaders required.
- Uses [Shiki](https://shiki.style) for syntax highlighting with extensive grammars and themes.
- Lazy loading: pre-highlight code with Shiki while loading `monaco-editor-core` in the background.
- Supports server-side rendering (SSR).
- Workspace features (edit history, file system provider, persist protocol, etc.).
- Automatically loads `.d.ts` files from [esm.sh](https://esm.sh) CDN for type checking.
- Uses [import maps](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) for resolving **bare specifier** imports in JavaScript/TypeScript.
- VSCode `window` APIs like `showInputBox`, `showQuickPick`, etc.
- Embedded languages (importmap/CSS/JavaScript) in HTML.
- Inline `html` and `css` in JavaScript/TypeScript.
- Auto-closing HTML/JSX tags.

## Installation

You can install modern-monaco from NPM:

```bash
npm i modern-monaco
```

Or import it from [esm.sh](https://esm.sh/) CDN in the browser without a build step:

```js
import * from "https://esm.sh/modern-monaco"
```

## Usage

modern-monaco provides three modes to create a browser-based code editor:

- **Lazy**: pre-highlight code with Shiki while loading the `editor-core.js` in the background.
- **SSR**: render a mock editor on the server side and hydrates it on the client side.
- **Manual**: create a Monaco editor instance manually.

### Lazy Mode

[monaco-editor](https://www.npmjs.com/package/monaco-editor) is a large package with additional CSS/Worker modules that requires `MonacoEnvironment` setup for language service support. modern-monaco provides a simple yet smart way to load editor modules on demand.

By pre-highlighting code with Shiki while loading editor modules in the background, modern-monaco can significantly reduce loading screen time.

To create a Monaco editor lazily, you need to add a `<monaco-editor>` custom element in the HTML of your app, then call the `lazy` function provided by modern-monaco. You may also need a `Workspace` object to manage editor models without calling the native Monaco APIs.

```html
<!-- index.html -->
<monaco-editor></monaco-editor>
<script src="app.js" type="module"></script>
```

```js
// app.js
import { lazy, Workspace } from "modern-monaco";

// create a workspace with initial files
const workspace = new Workspace({
  initialFiles: {
    "index.html": `<html><body>...</body></html>`,
    "main.js": `console.log("Hello, world!")`,
  },
  entryFile: "index.html",
});

// initialize the editor lazily
await lazy({ workspace });

// write a file and open it in the editor
workspace.fs.writeFile("util.js", "export function add(a, b) { return a + b; }");
workspace.openTextDocument("util.js");
```

### SSR Mode

SSR mode returns an instant pre-rendered editor on the server side and hydrates it on the client side.

```js
import { renderToWebComponent } from "modern-monaco/ssr";

export default {
  async fetch(req) {
    const editorHTML = await renderToWebComponent(
      `console.log("Hello, world!")`,
      {
        language: "javascript",
        theme: "vitesse-dark",
        userAgent: req.headers.get("user-agent"), // detect default font for different platforms
      },
    );
    return new Response(
      /* html */ `
        ${editorHTML}
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

SSR Demo: https://modern-monaco-demo.vercel.app ([Source](https://github.com/pi0/modern-monaco-demo) by [@pi0](https://github.com/pi0))

### Manual Mode

You can also create a [Monaco editor](https://microsoft.github.io/monaco-editor/docs.html) instance manually. It loads themes and language grammars automatically.

```html
<div id="editor"></div>

<script type="module">
  import { init } from "modern-monaco";

  // load monaco-editor-core.js
  const monaco = await init();

  // create a Monaco editor instance
  const editor = monaco.editor.create(document.getElementById("editor"));

  // create and attach a model to the editor
  editor.setModel(monaco.editor.createModel(`console.log("Hello, world!")`, "javascript"));
</script>
```

## Using Workspace

modern-monaco provides VSCode-like workspace features, such as edit history, file system provider, and more.

```js
import { lazy, Workspace } from "modern-monaco";

// create a workspace with initial files
const workspace = new Workspace({
  /** The name of the workspace, used for project isolation. Default is "default". */
  name: "project-name",
  /** Initial files in the workspace. */
  initialFiles: {
    "index.html": `<html><head><title>Hello, world!</title></head><body><script src="main.js"></script></body></html>`,
    "main.js": `console.log("Hello, world!")`,
  },
  /** File to open when the editor is loaded for the first time. */
  entryFile: "index.html",
});

// use the workspace in lazy mode
lazy({ workspace });

// open a file in the workspace
workspace.openTextDocument("main.js");
```

### Custom Workspace FileSystem

By default, modern-monaco uses `IndexedDB` as the workspace filesystem to persist the editor changes. With a custom filesystem, you can implement your own persistence logic.

```ts
import { type FileSystem, lazy, Workspace } from "modern-monaco";

class CustomFileSystem implements FileSystem {
  // Custom FileSystem implementation
}

const workspace = new Workspace({
  initialFiles: {
    "index.html": indexHtml,
    "app.tsx": appTsx,
  },
  customFS: new CustomFileSystem(),
});

lazy({ workspace });
```

Please refer to the [FileSystem](./types/workspace.d.ts#L54) interface for more details.

## Editor Theme & Language Grammars

modern-monaco uses [Shiki](https://shiki.style) for syntax highlighting with extensive grammars and themes. By default, it loads themes and grammars from esm.sh on demand.

### Setting the Editor Theme

To set the editor theme, you can add a `theme` attribute to the `<monaco-editor>` element.

```html
<monaco-editor theme="vitesse-dark"></monaco-editor>
```

Or set it in the `lazy`, `init`, or `hydrate` function.

```js
lazy({
  theme: "vitesse-dark",
});
```

> [!Note]
> The theme ID should be one of the [Shiki Themes](https://shiki.style/themes).

modern-monaco loads the theme data from the CDN when a theme ID is provided. You can also use a theme from the `tm-themes` package:

```js
import OneDark from "tm-themes/themes/vitesse-dark.json" with { type: "json" };

lazy({
  theme: OneDark,
});
```

### Pre-loading Language Grammars

By default, modern-monaco loads language grammars when a specific language mode is attached to the editor. You can also pre-load language grammars by adding the `langs` option to the `lazy`, `init`, or `hydrate` functions. The `langs` option is an array of language grammars, which can be a language grammar object, a language ID, or a URL to the language grammar.

```js
import markdown from "tm-grammars/markdown.json" with { type: "json" };

lazy({
  langs: [
    // load language grammars from CDN, these language ids must be defined in the `tm-grammars` package
    "html",
    "css",
    "javascript",
    "json",

    // load language grammar from a URL
    "https://example.com/grammars/mylang.json",

    // load language grammar from a local file
    "/assets/mylang.json",

    // use `tm-grammars` package without extra HTTP requests, but increases the bundle size
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
  // The CDN for loading language grammars and themes. Default is "https://esm.sh"
  cdn: "https://esm.sh",
});
```

## Editor Options

You can set editor options as attributes in the `<monaco-editor>` element. The editor options are the same as [`editor.EditorOptions`](https://microsoft.github.io/monaco-editor/docs.html#variables/editor.EditorOptions.html).

```html
<monaco-editor
  theme="vitesse-dark"
  fontFamily="Geist Mono"
  fontSize="16"
></monaco-editor>
```

For SSR mode, you can set editor options in the `renderToWebComponent` function.

```js
import { renderToWebComponent } from "modern-monaco/ssr";

const html = await renderToWebComponent(
  `console.log("Hello, world!")`,
  {
    theme: "vitesse-dark",
    language: "javascript",
    fontFamily: "Geist Mono",
    fontSize: 16,
  },
);
```

For manual mode, check [here](https://microsoft.github.io/monaco-editor/docs.html#functions/editor.create.html) for more details.

## Language Server Protocol (LSP)

modern-monaco by default supports full LSP features for the following languages:

- HTML
- CSS/SCSS/LESS
- JavaScript/TypeScript
- JSON

Additionally, modern-monaco supports features like:

- File System Provider for import completions
- Embedded languages in HTML
- Inline `html` and `css` in JavaScript/TypeScript
- Auto-closing HTML/JSX tags

> [!Note]
> You don't need to set `MonacoEnvironment.getWorker` for LSP support.
> modern-monaco automatically loads the required LSP workers.

### LSP Language Configuration

You can configure built-in LSPs in the `lazy`, `init`, or `hydrate` functions.

```js
lazy({
  lsp: {
    // formatting options for all languages
    formatting: {/* ... */},
    // configure LSP for languages
    html: {/* ... */},
    css: {/* ... */},
    json: {/* ... */},
    typescript: {/* ... */},
  },
});
```

The `LSPConfig` interface is defined as:

```ts
export interface LSPConfig {
  /** Formatting options. */
  formatting?: {
    /** Size of a tab in spaces. Default: 4. */
    tabSize?: number;
    /** Prefer spaces over tabs. Default: true.*/
    insertSpaces?: boolean;
    /** Trim trailing whitespace on a line. Default: true. */
    trimTrailingWhitespace?: boolean;
    /** Insert a newline character at the end of the file if one does not exist. Default: false. */
    insertFinalNewline?: boolean;
    /** Trim all newlines after the final newline at the end of the file. Default: false. */
    trimFinalNewlines?: boolean;
    /** Semicolon preference for JavaScript and TypeScript. Default: "insert". */
    semicolon?: "ignore" | "insert" | "remove";
  }
  /** HTML language configuration. */
  html?: {
    attributeDefaultValue?: "empty" | "singlequotes" | "doublequotes";
    customTags?: ITagData[];
    hideAutoCompleteProposals?: boolean;
    hideEndTagSuggestions?: boolean;
  };
  /** CSS language configuration. */
  css?: {
    /** Defines whether the standard CSS properties, at-directives, pseudoClasses and pseudoElements are shown. */
    useDefaultDataProvider?: boolean;
    /** Provides a set of custom data providers. */
    dataProviders?: { [providerId: string]: CSSDataV1 };
  };
  /** JSON language configuration. */
  json?: {
      /** By default, the validator will return syntax and semantic errors. Set to false to disable the validator. */
      validate?: boolean;
      /** Defines whether comments are allowed or not. Default is disallowed. */
      allowComments?: boolean;
      /** A list of known schemas and/or associations of schemas to file names. */
      schemas?: JSONSchemaSource[];
      /** The severity of reported comments. Default is "error". */
      comments?: SeverityLevel;
      /** The severity of reported trailing commas. Default is "error". */
      trailingCommas?: SeverityLevel;
      /** The severity of problems from schema validation. Default is "warning". */
      schemaValidation?: SeverityLevel;
      /** The severity of problems that occurred when resolving and loading schemas. Default is "warning". */
      schemaRequest?: SeverityLevel;
  };
  /** TypeScript language configuration. */
  typescript?: {
    /** The compiler options. */
    compilerOptions?: ts.CompilerOptions;
    /** The global import map. */
    importMap?: ImportMap;
  };
}
```

### Import Maps

modern-monaco uses [import maps](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) to resolve **bare specifier** imports in JavaScript/TypeScript. By default, modern-monaco detects the `importmap` from the root `index.html` in the workspace.

```js
const indexHtml = /* html */ `<!DOCTYPE html>
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

You can also provide an import map object as the `lsp.typescript.importMap` option in the `lazy`, `init`, or `hydrate` functions.

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

### Adding `tsconfig.json`

You can add a `tsconfig.json` file to configure the TypeScript compiler options for the TypeScript language service.

```js
const tsconfig = {
  "compilerOptions": {
    "target": "ES2022",
    "strict": true,
  },
};
const workspace = new Workspace({
  initialFiles: {
    "tsconfig.json": JSON.stringify(tsconfig, null, 2),
  },
});
```

You can also manually add the TypeScript compiler options as the `lsp.typescript.compilerOptions` option in the `lazy`, `init`, or `hydrate` functions.

```js
lazy({
  lsp: {
    typescript: {
      compilerOptions: {
        target: "ES2022",
        strict: true,
      },
    },
  },
});
```

## Using the `core` Module

modern-monaco includes built-in grammars and LSP providers for HTML, CSS, JavaScript/TypeScript, and JSON. If you don't need these features, you can use the `modern-monaco/core` sub-module to reduce the bundle size.

```js
import { lazy } from "modern-monaco/core";

lazy();
```

## License

[MIT License](https://opensource.org/licenses/MIT)
