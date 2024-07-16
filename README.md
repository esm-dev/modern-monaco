> [!WARNING]
> **This project is currently under active development and is not ready for production use.**

# esm-monaco

A Code Editor powered by monaco-editor-core with radical ESM support. Core features include:

- ESM only, load dependencies on demand, no `MonacoEnvironment` required.
- Using [Shiki](https://shiki.style) for syntax highlighting with tons of themes and grammars.
- Pre-highlighting code with Shiki and load the editor.js in background.
- Support **server-side rendering(SSR)** with hydration in client side.
- Virtual File System(VFS) for multiple files editing.
- Automatically loading `.d.ts` from [esm.sh](https://esm.sh) for type checking.
- Using [import maps](https://github.com/WICG/import-maps) to resolving **bare specifier** import in JavaScript/TypeScript.
- Embedded languages(importmap/CSS/JavaScript) with LSP support in HTML.
- Inline `html` and `css` highlight in JavaScript/TypeScript.
- Auto-closing HTML/JSX tags.

Planned features:

- [ ] add import maps codelens (search NPM packages, update package version, etc.)
- [ ] add vscode `window` like API (showInputBox, showErrorMessage, etc.)
- [ ] support Emmet
- [ ] enable LSP for inline `html` and `css` in JavaScript/TypeScript

## Installation

You can install the package from NPM in your node project with a bundler like [vite](http://vitejs.dev).

```bash
npm i esm-monaco typescript
```

or import it from [esm.sh](https://esm.sh/) in browser without build step:

```js
import * from "https://esm.sh/esm-monaco"
```

> **Note**: The `typescript` package is required for JavaScript/TypeScript LSP support. We recommend `typescript@5.x.x` or later.

## Usage

There are three working modes for esm-monaco:

- **Lazy**: hightlight the code with Shiki and load `monaco-editor-core` in background.
- **SSR**: render the editor in server side, and hydrate it in client side.
- **Manual**: create a monaco editor instance manually.

### Lazy Mode

```html
<monaco-editor></monaco-editor>

<script type="module">
  import { lazy, VFS } from "https://esm.sh/esm-monaco";

  // create a virtual file system
  const vfs = new VFS({ scope: "APP_ID" });
  vfs.write("app.js", `console.log("Hello, world!")`);

  // initialize the editor lazily
  lazy({ vfs });
</script>
```

### SSR Mode

```js
import { renderToWebComponent } from "esm-monaco/ssr";

export default {
  fetch(req) => {
    const ssrOut = renderToWebComponent({
      code: `console.log("Hello, world!")`,
      filename: "app.js",
      userAgent: req.headers.get("User-Agent"), // for font detection
    });
    return new Response(html`
      ${ssrOut}
      <script type="module">
        import { hydrate, VFS } from "https://esm.sh/esm-monaco";

        // create a virtual file system
        const vfs = new VFS({ scope: "APP_ID" });

        // hydrate the editor
        hydrate({ vfs });
      </script>
    `, { headers: { "Content-Type": "text/html" }});
  }
}
```

### Manual Mode

```html
<div id="editor"></div>

<script type="module">
  import { init, VFS } from "https://esm.sh/esm-monaco";

  // create a virtual file system
  const vfs = new VFS({ scope: "APP_ID" });
  vfs.write("app.js", `console.log("Hello, world!")`);

  // load the monaco-editor-core
  const monacoNS = await init({ vfs });

  // create a monaco editor instance
  const editor = monaco.editor.create(document.getElementById("editor"), {
    /* add your editor options here */
  });

  // set the active model from the vfs
  vfs.openModel("app.js", editor)
</script>
```

## Editor Theme & Language Grammars

[Todo]

## Virtual File System(VFS)

[Todo]

## LSP

[Todo]

