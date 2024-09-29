> [!WARNING]
> **This project is currently under active development and is not ready for production use.**

# esm-monaco

A Web Code Editor powered by [monaco-editor-core](https://www.npmjs.com/package/monaco-editor-core) with radical ESM support. Core features include:

- ESM only, load dependencies on demand, no `MonacoEnvironment` required.
- Using [Shiki](https://shiki.style) for syntax highlighting with tons of grammars and themes.
- Pre-highlighting code with Shiki while loading `monaco-editor-core` in background.
- Support **server-side rendering(SSR)**.
- Builtin Virtual File System(VFS) for multiple files editing.
- Automatically loading `.d.ts` from [esm.sh](https://esm.sh) CDN for type checking.
- Using [import maps](https://github.com/WICG/import-maps) for resolving **bare specifier** imports in JavaScript/TypeScript.
- VSCode `window` APIs like `showInputBox`, `showQuickPick`, etc.
- Embedded languages(importmap/CSS/JavaScript) in HTML.
- Inline `html` and `css` in JavaScript/TypeScript.
- Auto-closing HTML/JSX tags.

Planned features:

- [ ] Show a loading indicator while loading the editor
- [ ] Quick open menu (only if the VFS is provided)
- [ ] Drag and drop file (only if the VFS is provided)
- [ ] Display non-code files in VFS, like images, videos, etc.
- [ ] VSCode `winodow.show<XXX>Message` APIs
- [ ] Emmet
- [ ] LSP for inline `html` and `css` in JavaScript/TypeScript
- [ ] Markdown language service
- [ ] [Volar](https://github.com/volarjs/volar.js) integration
- [ ] Support [Shiki JS RegExp Engine](https://shiki.style/guide/regex-engines#javascript-regexp-engine-experimental)

## Installation

You can install the package from NPM in your node project with a bundler like [vite](http://vitejs.dev).

```bash
npm i esm-monaco typescript
```

> [!Note]
> The `typescript` package is required by JavaScript/TypeScript LSP worker. We recommend `typescript@5.5.x` or later.

or import it from [esm.sh](https://esm.sh/) in browser without build step:

```js
import * from "https://esm.sh/esm-monaco"
```

## Usage

esm-monaco provides three modes to create a code editor:

- **Lazy**: pre-hightlight code with Shiki while loading the `editor-core.js` in background.
- **SSR**: render the editor in server side, and hydrate it in client side.
- **Manual**: create a monaco editor instance manually.

### Lazy Mode

[monaco-editor](https://www.npmjs.com/package/monaco-editor) is a large module with extra CSS/Worker dependencies, not mention the `MonacoEnvironment` setup. esm-monaco provides a lazy but smart way to load the editor on demand, and it pre-highlights code with Shiki while loading the `editor-core.js` in background.

```html
<monaco-editor></monaco-editor>

<script type="module">
  import { lazy, VFS } from "esm-monaco";

  // create a virtual file system
  const vfs = new VFS({
    initial: {
      "index.html": `<html><head><title>Hello, world!</title></head><body><script src="main.js"></script></body></html>`,
      "main.js": `console.log("Hello, world!")`
    }
  });

  // initialize the editor lazily
  lazy({ vfs });
</script>
```

### SSR Mode

SSR mode returns a instant rendered editor in server side, and hydrate it in client side.

```js
import { renderToWebComponent } from "esm-monaco/ssr";

export default {
  fetch(req) => {
    const ssrOut = renderToWebComponent({
      filename: "main.js",
      code: `console.log("Hello, world!")`,
      userAgent: req.headers.get("user-agent"), // default font detection for different platforms
    });
    return new Response(html`
      ${ssrOut}
      <script type="module">
        import { hydrate } from "https://esm.sh/esm-monaco";
        // hydrate the editor
        hydrate();
      </script>
    `, { headers: { "Content-Type": "text/html" }});
  }
}
```

### Manual Mode

You can also create a monaco editor instance manually.

```html
<div id="editor"></div>

<script type="module">
  import { init } from "esm-monaco";

  // load editor-core.js
  const monaco = await init();

  // create a monaco editor instance
  const editor = monaco.editor.create(document.getElementById("editor"));

  // create and attach a model to the editor
  editor.setModel(monaco.editor.createModel(`console.log("Hello, world!")`, "javascript"));
</script>
```

## Editor Theme & Language Grammars

esm-monaco uses [Shiki](https://shiki.style) for syntax highlighting with tons of grammars and themes. It loads themes and grammars from esm.sh on demand.

### Setting the Editor Theme

To set the theme of the editor, you can add a `theme` attribute to the `<monaco-editor>` element.

```html
<monaco-editor theme="theme-id"></monaco-editor>
```

or set it in the `lazy`, `init`, or `hydrate` function.

```js
lazy({ theme: "theme-id" });
```

> [!Note]
> The theme ID should be one of the [Shiki Themes](https://shiki.style/themes).

### Pre-loading Language Grammars

By default, esm-monaco loads language grammars when a specific language mode is attached in the editor. You can also pre-load language grammars by adding the `langs` option to the `lazy`, `init`, or `hydrate` function.

```js
lazy({
  langs: ["javascript", "typescript", "css", "html", "json", "markdown"],
});
```

### Custom Language Grammars

You can also add custom language grammars to the editor.

```js
lazy({
  langs: [
    // hand-crafted language grammar
    {
      name: "mylang",
      scopeName: "source.mylang",
      patterns: [/* ... */],
    },
    // or load a grammar from URL
    "https://example.com/grammars/mylang.json",
  ],
});
```

## Virtual File System(VFS)

The Virtual File System(VFS) of esm-monaco provides a way of multiple files editing.

- Editor navigation
- File system provider for language service worker
- Store files in indexedDB
- Watch file changes

```js
import { VFS } from "esm-monaco";

const vfs = new VFS({
  /** scope of the VFS, used for project isolation, default is "default" */
  scope: "my-project",
  /** initial files in the VFS */
  initial: {
    "index.html": `<html><head><title>Hello, world!</title></head><body><script src="main.js"></script></body></html>`,
    "main.js": `console.log("Hello, world!")`,
  },
  /** file to open when the editor is loaded at first time */
  entryFile: "index.html",
  /** editing history provider, default is "localStorage" */
  history: "browserHistory",
});
```

### Using the API of the VFS

You can use the API of the VFS to read, write, and watch files in a VFS.

```js
// read all files in the VFS
await vfs.ls();
// check if main.js exists
await vfs.exists("main.js");
// open main.js
await vfs.open("main.js");
// read main.js as Uint8Array
await vfs.readFile("main.js");
// read main.js as text
await vfs.readTextFile("main.js");
// write content to main.js
await vfs.writeFile("main.js", `console.log("Hello, world!")`);
// remove main.js
await vfs.remove("main.js");
// watch main.js for changes
vfs.watch("main.js", (evt) => console.log(`main.js has been ${evt.kind}`));
// watch all files for changes
vfs.watch("*", (evt) => console.log(`${evt.path} has been ${evt.kind}`));
```

### Adding `tsconfig.json`

You can also add a `tsconfig.json` file in the VFS to configure the TypeScript compiler options for the TypeScript language service worker.

```js
const tsconfig = {
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
  },
};
const vfs = new VFS({
  initial: {
    "tsconfig.json": JSON.stringify(tsconfig, null, 2),
  },
});
```

### Dedetecting Import Maps

esm-monaco use [import maps](https://github.com/WICG/import-maps) to resolving **bare specifier** import in JavaScript/TypeScript.
By default, esm-monaco will dedetect the import maps in the `index.html` file in the VFS if it exists.

```js
const indexHtml = html`<!DOCTYPE html>
<html>
  <head>
    <script type="importmap">
      {
        "imports": {
          "@jsxRuntime": "https://esm.sh/react@18",
          "react": "https://esm.sh/react@18"
        }
      }
    </script>
  </head>
  <body>
  <script type="module">
    import React from "react";
  </script>
  </body>
</html>
`;
const vfs = new VFS({
  initial: {
    "index.html": indexHtml,
  },
});
```

or you can add a `importmap.json` file in the VFS to configure the import maps.

```js
const importmap = {
  "imports": {
    "@jsxRuntime": "https://esm.sh/react@18",
    "react": "https://esm.sh/react@18",
  },
};
const vfs = new VFS({
  initial: {
    "importmap.json": JSON.stringify(importmap),
  },
});
```

> [!Note]
> The `@jsxRuntime` is a special specifier for `jsxImportSource` option in TypeScript compiler options.

### Editing History Provider

By default, esm-monaco stores your last editing history in the `localStorage`. You can also use your own history provider, for example, use the browser history API that switches the editor content when you navigate back and forth.

```js
const vfs = new VFS({
  history: "browserHistory",
});
```

## Editor Options

You can set the editor options in the `<monaco-editor>` element as attributes. The editor options are the same as the [`editor.EditorOptions`](https://microsoft.github.io/monaco-editor/docs.html#variables/editor.EditorOptions.html).

```html
<monaco-editor
  theme="theme-id"
  fontFamily="MONO-FONT"
  fontSize="16"
></monaco-editor>
```

For SSR mode, you can set the editor options in the `renderToWebComponent` function.

```js
import { renderToWebComponent } from "esm-monaco/ssr";

const html = renderToWebComponent({
  // render options
  filename: "main.js",
  code: `console.log("Hello, world!")`,
  userAgent: req.headers.get("user-agent"), // font detection for different platforms

  // editor options
  theme: "theme-id",
  fontFamily: "MONO-FONT",
  fontSize: 16,
  // ...
});
```

For manual mode, check [here](https://microsoft.github.io/monaco-editor/docs.html#functions/editor.create.html) for more details.

## VSCode `window` APIs compatibility

esm-monaco adds some of the `window` APIs from VSCode:

- [`showInputBox`](https://code.visualstudio.com/api/references/vscode-api#window.showInputBox) - Show an input box to ask for user input.
- [`showQuickPick`](https://code.visualstudio.com/api/references/vscode-api#window.showQuickPick) - Show a selection list to ask for user input.

```js
import { init } from "esm-monaco";
const monaco = await init();

monaco.showInputBox({
  title: "What's your name?",
  placeHolder: "Enter your name here",
  value: "John Doe",
}).then(name => {
  console.log(`Hello, ${name}!`);
});
```

## Language Server Protocol(LSP)

esm-monaco by default supports full LSP features for following languages:

- **HTML**
- **CSS/SCSS/LESS**
- **JavaScript/TypeScript**
- **JSON**

Plus, esm-monaco also supports features like:

- **Auto-closing HTML/JSX tags**
- **Embedded languages in HTML**
- **File System Provider by VFS**

> [!Note]
> You don't need to set the `MonacoEnvironment.getWorker` for LSP support.
> esm-monaco will automatically load the LSP worker for you.

### LSP language configuration

You can configure the LSP languages in the `lazy`, `init`, or `hydrate` function.

```js
// configure the LSP languages
lazy({
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
    schemas?: JSONSchemaSource[];
  };
  typescript?: {
    /** The compiler options. */
    compilerOptions?: ts.CompilerOptions;
    /** The global import maps. */
    importMap?: ImportMap;
    /** The version of the typescript from CDN. Default: ">= 5.5.0" */
    tsVersion?: string;
  };
}
```

### Custom LSP

[TODO]
