import type monacoNS from "monaco-editor-core";
import type { Highlighter, RenderOptions, ShikiInitOptions } from "./shiki.ts";
import type { VFS } from "./vfs.ts";
import type { LSPConfig } from "./lsp/index.ts";
import { createWebWorker, margeProviders } from "./lsp/index.ts";
import syntaxes from "./syntaxes/index.ts";

// ! external modules, don't remove the `.js` extension
import { getLanguageIdFromPath, initShiki, setDefaultWasmLoader, tmGrammars } from "./shiki.js";
import { initShikiMonacoTokenizer, registerShikiMonacoTokenizer } from "./shiki.js";
import { render } from "./shiki.js";
import { getWasmInstance } from "./shiki-wasm.js";

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
const preloadGrammars = [
  "html",
  "css",
  "javascript",
  "json",
];

export interface InitOption extends ShikiInitOptions {
  vfs?: VFS;
  lsp?: LSPConfig;
}

/** Load the monaco editor and use shiki as the tokenizer. */
async function loadMonaco(highlighter: Highlighter, options?: InitOption, onEditorWorkerReady?: () => void) {
  const monaco = await import("./editor-core.js");
  const vfs = options?.vfs;
  const lspProviders = margeProviders(options.lsp);

  if (vfs) {
    vfs.setup(monaco);
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
      let provider = lspProviders[label];
      if (!provider) {
        provider = Object.values(lspProviders).find((p) => p.aliases?.includes(label));
      }
      const url = provider ? (await provider.import()).getWorkerUrl() : monaco.getWorkerUrl();
      const worker = createWebWorker(url);
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

  // add keybinding `cmd+k` for opening the quick command palette on macOS
  if (globalThis.navigator?.userAgent?.includes("Macintosh")) {
    monaco.editor.addKeybindingRule({
      keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK,
      command: "editor.action.quickCommand",
    });
  }

  // use the shiki as the tokenizer for the monaco editor
  const allLanguages = new Set(tmGrammars.filter(g => !g.injectTo).map(g => g.name));
  allLanguages.forEach((id) => {
    monaco.languages.register({ id, aliases: tmGrammars.find(g => g.name === id)?.aliases });
    monaco.languages.onLanguage(id, async () => {
      const config = monaco.languageConfigurations[monaco.languageConfigurationAliases[id] ?? id];
      if (config) {
        monaco.languages.setLanguageConfiguration(id, monaco.convertVscodeLanguageConfiguration(config));
      }

      const loadedGrammars = new Set(highlighter.getLoadedLanguages());
      const reqiredGrammars = [id]
        .concat(tmGrammars.find(g => g.name === id)?.embedded ?? [])
        .filter((id) => !loadedGrammars.has(id));
      if (reqiredGrammars.length > 0) {
        await highlighter.loadGrammarFromCDN(...reqiredGrammars);
      }

      registerShikiMonacoTokenizer(monaco, highlighter, id);

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
  initShikiMonacoTokenizer(monaco, highlighter);

  return monaco;
}

/* Initialize and return the monaco editor namespace. */
export async function init(options?: InitOption): Promise<typeof monacoNS> {
  const langs = (options?.langs ?? []).concat(preloadGrammars, syntaxes as any[]);
  const hightlighter = await initShiki({ ...options, langs });
  return loadMonaco(hightlighter, options);
}

/** Render a mock editor, then load the monaco editor in background. */
export function lazy(options?: InitOption, hydrate?: boolean) {
  const vfs = options?.vfs;

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

        let filename = renderOptions.filename ?? this.getAttribute("file");
        if (!filename && vfs) {
          if (vfs.history.current) {
            filename = vfs.history.current;
          } else if (vfs.defaultFile) {
            filename = vfs.defaultFile;
            vfs.history.replace(filename);
          } else {
            const list = await vfs.ls();
            filename = list[0];
            vfs.history.replace(filename);
          }
        }

        const langs = (options?.langs ?? []).concat(preloadGrammars, syntaxes as any[]);
        if (renderOptions.language || filename) {
          langs.push(renderOptions.language ?? getLanguageIdFromPath(filename));
        }

        // create a highlighter instance for the renderer/editor
        const highlighter = await initShiki({ theme: renderOptions.theme, ...options, langs });

        // check the pre-rendered content, if not exists, render one
        let prerenderEl = hydrate ? this.querySelector<HTMLElement>(".monaco-editor-prerender") : undefined;
        if (!prerenderEl && filename && vfs) {
          try {
            const code = await vfs.readTextFile(filename);
            const language = getLanguageIdFromPath(filename);
            prerenderEl = containerEl.cloneNode(true) as HTMLElement;
            prerenderEl.className = "monaco-editor-prerender";
            prerenderEl.innerHTML = render(highlighter, {
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

        if (prerenderEl) {
          prerenderEl.style.position = "absolute";
          prerenderEl.style.top = "0";
          prerenderEl.style.left = "0";
          this.appendChild(prerenderEl);
          if (filename) {
            const scrollTop = vfs.viewState[new URL(filename, "file:///").href]?.viewState?.scrollTop ?? 0;
            if (scrollTop > 0) {
              prerenderEl.querySelector(".mock-monaco-editor").scrollTop = scrollTop;
            }
          }
        }

        // load and rander the monaco editor
        async function createMonaco() {
          const monaco = await loadMonacoCore(highlighter);
          const editor = monaco.editor.create(containerEl, renderOptions);
          if (vfs) {
            const saveViewState = () => {
              const currentModel = editor.getModel();
              if (currentModel?.uri.scheme === "file") {
                const vs = editor.saveViewState();
                vs.viewState.scrollTop ??= editor.getScrollTop();
                vfs.viewState[currentModel.uri.toString()] = Object.freeze(vs);
              }
            };
            const debunce = (fn: () => void, delay = 500) => {
              let timer: number | null = null;
              return () => {
                if (timer !== null) {
                  clearTimeout(timer);
                }
                timer = setTimeout(() => {
                  timer = null;
                  fn();
                }, delay);
              };
            };
            editor.onDidChangeCursorSelection(debunce(saveViewState));
            editor.onDidScrollChange(debunce(saveViewState));
            vfs.history.onChange((uri) => {
              if (editor.getModel()?.uri.toString() !== uri) {
                vfs.openModel(uri, editor);
              }
            });
          }
          if (vfs && filename) {
            try {
              const model = await vfs.openModel(filename, editor);
              // update the model value with the SSR `code` if exists
              if (
                renderOptions.filename === filename
                && renderOptions.code
                && renderOptions.code !== model.getValue()
              ) {
                model.setValue(renderOptions.code);
              }
            } catch (error) {
              if (error instanceof vfs.ErrorNotFound) {
                if ((renderOptions.code && renderOptions.filename)) {
                  await vfs.writeFile(renderOptions.filename, renderOptions.code);
                  vfs.openModel(renderOptions.filename, editor);
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
              renderOptions.filename,
            );
            editor.setModel(model);
          } else {
            // open an empty model
            editor.setModel(monaco.editor.createModel(""));
          }
          // hide the prerender element if exists
          if (prerenderEl && editorWorkerPromise) {
            editorWorkerPromise.then(() => {
              setTimeout(() => {
                const animate = prerenderEl.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 150 });
                if (animate) {
                  animate.finished.then(() => prerenderEl.remove());
                } else {
                  // don't support animation api
                  setTimeout(() => prerenderEl.remove(), 150);
                }
              }, 100);
            });
          }
        }
        await createMonaco();
      }
    },
  );
}

/** Hydrate the monaco editor in the browser. */
export function hydrate(options?: InitOption) {
  return lazy(options, true);
}

// set shiki wasm loader
setDefaultWasmLoader(getWasmInstance);
