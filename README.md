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
- Using [import maps](https://github.com/WICG/import-maps) to resolving **bare specifier** import in JavaScript/TypeScript.
- VSCode `window` APIs like `showInputBox`, `showQuickPick`, etc.
- Embedded languages(importmap/CSS/JavaScript) in HTML.
- Inline `html` and `css` in JavaScript/TypeScript.
- Auto-closing HTML/JSX tags.

Planned features:

- [ ] Show a loading indicator while loading the editor
- [ ] Quick open file in VFS
- [ ] Drag and drop file (only if the VFS is provided)
- [ ] Display Non-Code files in VFS, like images, videos, etc.
- [ ] VSCode `winodow.show<XXX>Message` APIs
- [ ] Emmet
- [ ] LSP for inline `html` and `css` in JavaScript/TypeScript
- [ ] [Volar](https://github.com/volarjs/volar.js) integration

## Installation

You can install the package from NPM in your node project with a bundler like [vite](http://vitejs.dev).

```bash
npm i esm-monaco typescript
```

or import it from [esm.sh](https://esm.sh/) in browser without build step:

```js
import * from "https://esm.sh/esm-monaco"
```

> **Note**: The `typescript` package is required for JavaScript/TypeScript LSP support. We recommend `typescript@5.5.x` or later.

## Usage

esm-monaco provides three modes to create a code editor:

- **Lazy**: pre-hightlight code with Shiki while loading the `editor-core.js` in background.
- **SSR**: render the editor in server side, and hydrate it in client side.
- **Manual**: create a monaco editor instance manually.

### Lazy Mode

[monaco-editor-core](https://www.npmjs.com/package/monaco-editor-core) is a large module with extra CSS/Worker dependencies, not mention the `MonacoEnvironment` setup. esm-monaco provides a lazy but smart way to load the editor on demand. It pre-highlights code with Shiki while loading the `editor-core.js` in background.

```html
<monaco-editor></monaco-editor>

<script type="module">
  import { lazy, VFS } from "https://esm.sh/esm-monaco";

  // create a virtual file system
  const vfs = new VFS({ scope: "APP_ID" });

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
      filename: "app.js",
      code: `console.log("Hello, world!")`,
      userAgent: req.headers.get("user-agent"), // font detection for different platforms
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
  import { init } from "https://esm.sh/esm-monaco";

  // load editor-core.js
  const monaco = await init();

  // create a monaco editor instance
  const editor = monaco.editor.create(document.getElementById("editor"), {
    /* add your editor options here */
  });

  // create and attach a model to the editor
  editor.setModel(monaco.editor.createModel("console.log('Hello, world!')", "javascript"));
</script>
```

## Editor Theme & Language Grammars

[Todo]

## Virtual File System(VFS)

[Todo]

## VSCode `window` APIs compatibility

[Todo]

## LSP

[Todo]

