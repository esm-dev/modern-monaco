import type monacoNS from "monaco-editor-core";
import type { Highlighter, RenderOptions, ShikiInitOptions } from "./shiki.ts";
import type { VFS } from "./vfs.ts";
import type { LSPConfig } from "./lsp/index.ts";
import { createWorker, margeProviders } from "./lsp/index.ts";

// ! external module, don't remove the `.js` extension
import { getLanguageIdFromPath, getLanguageIdsInVFS, initShiki, setDefaultWasmLoader, tmGrammars } from "./shiki.js";
import { initShikiMonacoTokenizer, registerShikiMonacoTokenizer } from "./shiki.js";
import { render } from "./shiki.js";
import { getWasmInstance } from "./shiki-wasm.js";

setDefaultWasmLoader(getWasmInstance);

const editorProps = [
  "autoDetectHighContrast",
  "automaticLayout",
  "contextmenu",
  "cursorBlinking",
  "cursorSmoothCaretAnimation",
  "cursorStyle",
  "cursorWidth",
  "fontFamily",
  "fontLigatures",
  "fontSize",
  "fontVariations",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "lineNumbers",
  "lineNumbersMinChars",
  "matchBrackets",
  "minimap",
  "mouseStyle",
  "multiCursorModifier",
  "padding",
  "readOnly",
  "readOnlyMessage",
  "rulers",
  "scrollbar",
  "stickyScroll",
  "tabSize",
  "wordWrap",
];

export interface InitOption extends ShikiInitOptions {
  vfs?: VFS;
  lsp?: LSPConfig;
}

/** Load the monaco editor and use shiki as the tokenizer. */
async function loadMonaco(highlighter: Highlighter, options?: InitOption, onEditorWorkerReady?: () => void) {
  const monaco = await import("./editor-core.js");
  const editorWorkerUrl = monaco.getWorkerUrl();
  const vfs = options?.vfs;
  const lspProviders = margeProviders(options.lsp);

  if (vfs) {
    vfs.bindMonaco(monaco);
  }

  // insert the monaco editor core css
  if (!document.getElementById("monaco-editor-core-css")) {
    const styleEl = document.createElement("style");
    styleEl.id = "monaco-editor-core-css";
    styleEl.media = "screen";
    // @ts-expect-error `_CSS` is defined at build time
    styleEl.textContent = monaco._CSS;
    document.head.appendChild(styleEl);
  }

  // set the global `MonacoEnvironment` object
  Reflect.set(globalThis, "MonacoEnvironment", {
    workerProxies: {},
    onWorker: (languageId: string, workerProxy: () => any) => {
      const workerProxies = Reflect.get(MonacoEnvironment, "workerProxies");
      const promise = workerProxies[languageId];
      if (typeof promise === "object" && promise !== null && "resolve" in promise) {
        promise.resolve();
      }
      workerProxies[languageId] = workerProxy;
    },
    getWorker: async (_workerId: string, label: string) => {
      let url = editorWorkerUrl;
      let provider = lspProviders[label];
      if (!provider) {
        provider = Object.values(lspProviders).find((p) => p.aliases?.includes(label));
      }
      if (provider) {
        url = (await (provider.import())).getWorkerUrl();
      }
      const worker = await createWorker(url);
      if (!provider) {
        const onMessage = (e: MessageEvent) => {
          onEditorWorkerReady?.();
          worker.removeEventListener("message", onMessage);
        };
        worker.addEventListener("message", onMessage);
      }
      return worker;
    },
    getLanguageIdFromUri: (uri: monacoNS.Uri) => getLanguageIdFromPath(uri.path),
  });

  // prevent to open the http link which is a model
  monaco.editor.registerLinkOpener({
    async open(link) {
      if ((link.scheme === "https" || link.scheme === "http") && monaco.editor.getModel(link)) {
        return true;
      }
    },
  });

  // register the editor opener for the monaco editor
  monaco.editor.registerEditorOpener({
    openCodeEditor: async (editor, resource, selectionOrPosition) => {
      if (vfs && resource.scheme === "file") {
        try {
          await vfs.openModel(resource.toString(), editor, selectionOrPosition);
          return true;
        } catch (err) {
          if (err instanceof vfs.ErrorNotFound) {
            return false;
          }
          throw err;
        }
      }
      try {
        const model = monaco.editor.getModel(resource);
        if (model) {
          editor.setModel(model);
          if (selectionOrPosition) {
            if ("startLineNumber" in selectionOrPosition) {
              editor.setSelection(selectionOrPosition);
            } else {
              editor.setPosition(selectionOrPosition);
            }
            const pos = editor.getPosition();
            editor.setScrollTop(
              editor.getScrolledVisiblePosition(new monaco.Position(pos.lineNumber - 7, pos.column)).top,
            );
          }
          const isHttpUrl = resource.scheme === "https" || resource.scheme === "http";
          editor.updateOptions({ readOnly: isHttpUrl });
          return true;
        }
      } catch (error) {}
      return false;
    },
  });

  // add keybinding `cmd+k` open command palette (only for macintosh)
  if (globalThis.navigator?.userAgent?.includes("Macintosh")) {
    monaco.editor.addKeybindingRule({
      keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK,
      command: "editor.action.quickCommand",
    });
  }

  // use the shiki as the tokenizer for the monaco editor
  const allLanguages = new Set([...tmGrammars.map(g => g.name), ...highlighter.getLoadedLanguages()]);
  allLanguages.forEach((id) => {
    monaco.languages.register({ id, aliases: tmGrammars.find(g => g.name === id)?.aliases });
    monaco.languages.onLanguage(id, () => {
      const config = monaco.languageConfigurations[monaco.languageConfigurationAliases[id] ?? id];
      if (config) {
        monaco.languages.setLanguageConfiguration(id, monaco.convertVscodeLanguageConfiguration(config));
      }
      if (!highlighter.getLoadedLanguages().includes(id)) {
        highlighter.loadLanguageFromCDN(id).then(() => {
          // register tokenizer for the language
          registerShikiMonacoTokenizer(monaco, highlighter, id);
        });
      }
      let label = id;
      let provider = lspProviders[label];
      if (!provider) {
        [label, provider] = Object.entries(lspProviders).find(([, lsp]) => lsp.aliases?.includes(id)) ?? [];
      }
      if (provider) {
        provider.import().then(({ setup }) => setup(monaco, id, options?.[label], options?.lsp?.format, vfs));
      }
    });
  });

  // using the shiki as the tokenizer for the monaco editor
  initShikiMonacoTokenizer(monaco, highlighter, [...allLanguages]);

  return monaco;
}

let loading: Promise<typeof monacoNS> | undefined;
let ssrHighlighter: Highlighter | Promise<Highlighter> | undefined;

/* Initialize and return the monaco editor namespace. */
export function init(options?: InitOption): Promise<typeof monacoNS> {
  if (!loading) {
    const load = async () => {
      const langs = options?.langs ?? [];
      const vfs = options?.vfs;
      const lspProviders = margeProviders(options.lsp);
      if (vfs) {
        const ids = (await getLanguageIdsInVFS(vfs)).filter((name) => !langs.includes(name));
        if (ids.length > 0) {
          langs.push(...ids);
        }
      }
      for (const l of Object.values(lspProviders)) {
        if (l.syntaxes) {
          langs.push(...l.syntaxes);
        }
      }
      const hightlighter = await initShiki({ ...options, langs });
      return loadMonaco(hightlighter, options);
    };
    loading = load();
  }
  return loading;
}

/** Render a mock editor, then load the monaco editor in background. */
export function lazy(options?: InitOption, hydrate?: boolean) {
  const vfs = options?.vfs;
  const lspProviders = margeProviders(options.lsp);

  let monacoCore: typeof monacoNS | Promise<typeof monacoNS> | null = null;
  let editorWorkerPromise: Promise<void> | null = null;

  function loadMonacoCore(highlighter: Highlighter) {
    if (monacoCore) {
      return monacoCore;
    }
    let onEditorWorkerReady: (() => void) | undefined;
    editorWorkerPromise = new Promise<void>((resolve) => {
      onEditorWorkerReady = resolve;
    });
    return monacoCore = loadMonaco(highlighter, options, onEditorWorkerReady).then((m) => monacoCore = m);
  }

  customElements.define(
    "monaco-editor",
    class extends HTMLElement {
      constructor() {
        super();
        Object.assign(this.style, { display: "block", position: "relative" });
      }

      async connectedCallback() {
        const renderOptions: Partial<RenderOptions> = {};

        // parse editor/render options from attributes
        for (const attrName of this.getAttributeNames()) {
          const key = editorProps.find((k) => k.toLowerCase() === attrName);
          if (key) {
            let value: any = this.getAttribute(attrName);
            if (value === "") {
              value = key === "minimap" || key === "stickyScroll" ? { enabled: true } : true;
            } else {
              value = value.trim();
              if (value === "true") {
                value = true;
              } else if (value === "false") {
                value = false;
              } else if (value === "null") {
                value = null;
              } else if (/^\d+$/.test(value)) {
                value = Number(value);
              } else if (/^\{.+\}$/.test(value)) {
                try {
                  value = JSON.parse(value);
                } catch (error) {
                  value = undefined;
                }
              }
            }
            if (key === "padding") {
              if (typeof value === "number") {
                value = { top: value, bottom: value };
              } else if (/^\d+\s+\d+$/.test(value)) {
                const [top, bottom] = value.split(/\s+/);
                if (top && bottom) {
                  value = { top: Number(top), bottom: Number(bottom) };
                }
              } else {
                value = undefined;
              }
            }
            if (key === "wordWrap" && (value === "on" || value === true)) {
              value = "on";
            }
            if (value !== undefined) {
              renderOptions[key] = value;
            }
          }
        }

        // get editor options of the SSR rendering if exists
        if (hydrate) {
          const optionsScript = this.children[0] as HTMLScriptElement | null;
          if (optionsScript && optionsScript.tagName === "SCRIPT" && optionsScript.className === "monaco-editor-options") {
            const opts = JSON.parse(optionsScript.textContent);
            // we save the `fontDigitWidth` as a global variable, this is used for keeping the line numbers
            // layout consistent between the SSR render and the client pre-render.
            if (opts.fontDigitWidth) {
              Reflect.set(globalThis, "__monaco_maxDigitWidth", opts.fontDigitWidth);
            }
            Object.assign(renderOptions, opts);
            optionsScript.remove();
          }
        }

        // set dimension from width and height attributes
        const width = Number(this.getAttribute("width"));
        const height = Number(this.getAttribute("height"));
        if (width > 0 && height > 0) {
          this.style.width = `${width}px`;
          this.style.height = `${height}px`;
          renderOptions.dimension = { width, height };
        }

        // the container element for monaco editor instance
        const containerEl = document.createElement("div");
        containerEl.className = "monaco-editor-container";
        containerEl.style.width = "100%";
        containerEl.style.height = "100%";
        this.appendChild(containerEl);

        // create a highlighter instance for the renderer/editor
        const langs = options?.langs ?? [];
        let file = renderOptions.filename ?? this.getAttribute("file");
        if (!file && vfs) {
          if (vfs.state.activeFile) {
            file = vfs.state.activeFile;
          } else {
            const list = await vfs.ls();
            vfs.state.activeFile = file = list[0];
          }
        }
        if (renderOptions.language || file) {
          langs.push(renderOptions.language ?? getLanguageIdFromPath(file));
        }
        for (const l of Object.values(lspProviders)) {
          if (l.syntaxes) {
            langs.push(...l.syntaxes);
          }
        }
        if (renderOptions.theme) {
          options.theme = renderOptions.theme;
        }
        const highlighter = await initShiki({ ...options, langs });

        // check the pre-rendered content, if not exists, render one
        let mockEl = hydrate ? this.querySelector<HTMLElement>(".monaco-editor-prerender") : undefined;
        if (!mockEl && file && vfs) {
          try {
            const code = await vfs.readTextFile(file);
            const language = getLanguageIdFromPath(file);
            mockEl = containerEl.cloneNode(true) as HTMLElement;
            mockEl.className = "monaco-editor-prerender";
            mockEl.innerHTML = render(highlighter, {
              ...renderOptions,
              code,
              language,
            });
          } catch (error) {
            if (error instanceof vfs.ErrorNotFound) {
              // ignore
            } else {
              throw error;
            }
          }
        }
        if (mockEl) {
          mockEl.style.position = "absolute";
          mockEl.style.top = "0";
          mockEl.style.left = "0";
          this.appendChild(mockEl);
        }

        // load monaco editor
        (async () => {
          const monaco = await loadMonacoCore(highlighter);
          const editor = monaco.editor.create(containerEl, renderOptions);
          if (vfs) {
            editor.onWillChangeModel((e) => {
              vfs.viewState[e.oldModelUrl.toString()] = editor.saveViewState();
            });
          }
          if (vfs && file) {
            try {
              const model = await vfs.openModel(file, editor);
              // update the model value with the code from SSR if exists
              if (
                renderOptions.filename === file
                && renderOptions.code
                && renderOptions.code !== model.getValue()
              ) {
                model.setValue(renderOptions.code);
              }
            } catch (error) {
              if (error instanceof vfs.ErrorNotFound) {
                if ((renderOptions.code && renderOptions.filename)) {
                  await vfs.writeFile(renderOptions.filename, renderOptions.code);
                  vfs.openModel(renderOptions.filename);
                } else {
                  // open an empty model
                  editor.setModel(monaco.editor.createModel(""));
                }
              } else {
                throw new Error(`[vfs] Failed to open file: ` + error.message);
              }
            }
          } else if ((renderOptions.code && (renderOptions.language || renderOptions.filename))) {
            const model = monaco.editor.createModel(
              renderOptions.code,
              renderOptions.language,
              // @ts-expect-error the overwrited `createModel` method supports
              // path(string) as the third argument(URI)
              renderOptions.filename,
            );
            editor.setModel(model);
          } else {
            // open an empty model
            editor.setModel(monaco.editor.createModel(""));
          }
          // hide the prerender element if exists
          if (mockEl && editorWorkerPromise) {
            editorWorkerPromise.then(() => {
              setTimeout(() => {
                const animate = mockEl.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 150 });
                if (animate) {
                  animate.finished.then(() => mockEl.remove());
                } else {
                  // don't support animation api
                  setTimeout(() => mockEl.remove(), 150);
                }
              }, 100);
            });
          }
          // load required grammars in background
          if (vfs) {
            for (const id of await getLanguageIdsInVFS(vfs)) {
              highlighter.loadLanguageFromCDN(id).then(() => {
                registerShikiMonacoTokenizer(monaco, highlighter, id);
              });
            }
          }
        })();
      }
    },
  );
}

/** Hydrate the monaco editor in the browser. */
export function hydrate(options?: InitOption) {
  return lazy(options, true);
}

/** Initialize a highlighter instance for rendering. */
async function initRenderHighlighter(options: RenderOptions): Promise<Highlighter> {
  const highlighter = await (ssrHighlighter ?? (ssrHighlighter = initShiki(options.shiki)));
  const { filename, language, theme } = options;
  const promises: Promise<void>[] = [];
  if (language || filename) {
    const languageId = language ?? getLanguageIdFromPath(filename);
    if (!highlighter.getLoadedLanguages().includes(languageId)) {
      console.info(`[esm-monaco] Loading garmmar '${languageId}' from esm.sh ...`);
      promises.push(highlighter.loadLanguageFromCDN(languageId));
    }
  }
  if (theme) {
    if (!highlighter.getLoadedThemes().includes(theme)) {
      console.info(`[esm-monaco] Loading theme '${theme}' from esm.sh ...`);
      promises.push(highlighter.loadThemeFromCDN(theme));
    }
  }
  if (promises.length > 0) {
    await Promise.all(promises);
  }
  return highlighter;
}

/** Render a read-only(mock) editor in HTML string. */
export async function renderToString(options: RenderOptions): Promise<string> {
  const highlighter = await initRenderHighlighter(options);
  return render(highlighter, options);
}

/** Render a `<monaco-editor>` component in HTML string. */
export async function renderToWebComponent(options: RenderOptions): Promise<string> {
  const prerender = await renderToString(options);
  return (
    "<monaco-editor>"
    + "<script type=\"application/json\" class=\"monaco-editor-options\">"
    + JSON.stringify(options)
    + "</script>"
    + "<div class=\"monaco-editor-prerender\" style=\"width:100%;height:100%;\">"
    + prerender
    + "</div>"
    + "</monaco-editor>"
  );
}
