import type monacoNS from "monaco-editor-core";
import type { HighlighterCore } from "@shikijs/core";
import { shikiToMonaco } from "@shikijs/monaco";
import type { ShikiInitOptions } from "./shiki";
import { getGrammarsInVFS, getLanguageIdFromPath, initShiki } from "./shiki";
import { grammarRegistry, loadTMGrammer, loadTMTheme } from "./shiki";
import { createWorker, lspConfig, normalizeFormatOptions } from "./lsp/index";
import { render, type RenderOptions } from "./render";
import type { VFS } from "./vfs";

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
  "minimap",
  "mouseStyle",
  "multiCursorModifier",
  "padding",
  "readOnly",
  "readOnlyMessage",
  "rulers",
  "scrollbar",
  "tabSize",
  "wordWrap",
];

export interface InitOption extends ShikiInitOptions {
  vfs?: VFS;
  format?: Record<string, unknown>;
  json?: Record<string, unknown>;
  typescript?: Record<string, unknown>;
}

/** Load the monaco editor and use shiki as the tokenizer. */
async function loadMonaco(highlighter: HighlighterCore, options?: InitOption, onEditorWorkerReady?: () => void) {
  const vfs = options?.vfs;
  const monaco = await import("./editor-core.js");
  const editorWorkerUrl = monaco.getWorkerUrl();

  if (!document.getElementById("monaco-editor-core-css")) {
    const styleEl = document.createElement("style");
    styleEl.id = "monaco-editor-core-css";
    styleEl.media = "screen";
    // @ts-expect-error `_CSS` is defined at build time
    styleEl.textContent = monaco._CSS;
    document.head.appendChild(styleEl);
  }

  Reflect.set(globalThis, "MonacoEnvironment", {
    getWorker: async (_workerId: string, label: string) => {
      let url = editorWorkerUrl;
      let lsp = lspConfig[label];
      if (!lsp) {
        lsp = Object.values(lspConfig).find((lsp) => lsp.aliases?.includes(label));
      }
      if (lsp) {
        url = (await (lsp.import())).getWorkerUrl();
      }
      const worker = await createWorker(url);
      if (!lsp) {
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

  if (vfs) {
    vfs.bindMonaco(monaco);
  }

  let isPreloaded = false;
  const preloadDeps = () => {
    if (!isPreloaded) {
      import("./lsp/language-features.js");
      isPreloaded = true;
    }
  };

  grammarRegistry.forEach(({ name: id, aliases }) => {
    monaco.languages.register({ id, aliases });
    monaco.languages.onLanguage(id, () => {
      if (!highlighter.getLoadedLanguages().includes(id)) {
        highlighter.loadLanguage(loadTMGrammer({ name: id })).then(() => {
          // register tokenizer for the language
          shikiToMonaco(highlighter, monaco);
        });
      }
      let label = id;
      let lsp = lspConfig[label];
      if (!lsp) {
        [label, lsp] = Object.entries(lspConfig).find(([, lsp]) => lsp.aliases?.includes(id)) ?? [];
      }
      if (lsp) {
        const formatOptions = normalizeFormatOptions(label, options?.format);
        preloadDeps();
        lsp.import().then(({ setup }) => setup(monaco, id, options?.[label], formatOptions, vfs));
      }
    });
  });
  shikiToMonaco(highlighter, monaco);

  return monaco;
}

let loading: Promise<typeof monacoNS> | undefined;
let ssrHighlighter: HighlighterCore | Promise<HighlighterCore> | undefined;

/* Initialize and return the monaco editor namespace. */
export function init(options: InitOption = {}): Promise<typeof monacoNS> {
  if (!loading) {
    const load = async () => {
      const preloadGrammars = options.preloadGrammars ?? [];
      const customGrammars = options.customGrammars ?? [];
      const vfs = options.vfs;
      if (vfs) {
        const grammars = await getGrammarsInVFS(vfs);
        if (grammars.size > 0) {
          preloadGrammars.push(...grammars);
        }
      }
      for (const l of Object.values(lspConfig)) {
        if (l.embeddedGrammars) {
          customGrammars.push(...l.embeddedGrammars);
        }
      }
      const hightlighter = await initShiki({ ...options, preloadGrammars, customGrammars });
      return loadMonaco(hightlighter, options);
    };
    loading = load();
  }
  return loading;
}

/** Render a mock editor, then load the monaco editor in background. */
export function lazy(options?: InitOption) {
  const vfs = options?.vfs;

  let monacoCore: typeof monacoNS | Promise<typeof monacoNS> | null = null;
  let editorWorkerPromise: Promise<void> | null = null;

  function loadMonacoCore(highlighter: HighlighterCore) {
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
        this.style.display = "block";
        this.style.position = "relative";
      }

      async connectedCallback() {
        const renderOptions: Partial<RenderOptions> = {};

        // check editor/render options from attributes
        for (const attrName of this.getAttributeNames()) {
          const key = editorProps.find((k) => k.toLowerCase() === attrName);
          if (key) {
            let value: any = this.getAttribute(attrName);
            if (value === "") {
              value = attrName === "minimap" ? { enabled: true } : true;
            } else {
              try {
                value = JSON.parse(value);
              } catch {
                // ignore
              }
            }
            if (key === "padding" && typeof value === "number") {
              value = { top: value, bottom: value };
            }
            if (key === "wordWrap" && (value === "on" || value === true)) {
              value = "on";
            }
            renderOptions[key] = value;
          }
        }

        // check editor options from the first script child
        const optionsScript = this.children[0] as HTMLScriptElement | null;
        if (
          optionsScript &&
          optionsScript.tagName === "SCRIPT" &&
          optionsScript.type === "application/json"
        ) {
          const opts = JSON.parse(optionsScript.textContent);
          // we pass the `fontDigitWidth` option to the editor as a
          // custom class name. this is used for keeping the line numbers
          // layout consistent between the SSR render and the client pre-render.
          if (opts.fontDigitWidth) {
            opts.extraEditorClassName = [
              opts.extraEditorClassName,
              "font-digit-width-" +
              opts.fontDigitWidth.toString().replace(".", "_"),
            ].filter(Boolean).join(" ");
          }
          Object.assign(renderOptions, opts);
          optionsScript.remove();
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
        const preloadGrammars = options?.preloadGrammars ?? [];
        const customGrammars = options.customGrammars ?? [];
        let file = renderOptions.filename ?? this.getAttribute("file");
        if (!file && vfs) {
          if (vfs.state.activeFile) {
            file = vfs.state.activeFile;
          } else {
            const list = await vfs.list();
            vfs.state.activeFile = file = list[0];
          }
        }
        if (renderOptions.lang || file) {
          preloadGrammars.push(
            renderOptions.lang ?? getLanguageIdFromPath(file),
          );
        }
        for (const l of Object.values(lspConfig)) {
          if (l.embeddedGrammars) {
            customGrammars.push(...l.embeddedGrammars);
          }
        }
        const highlighter = await initShiki({ ...options, preloadGrammars, customGrammars });

        // check the pre-rendered content, if not exists, render one
        let mockEl = this.querySelector<HTMLElement>(".monaco-editor-prerender");
        if (!mockEl && file && vfs) {
          try {
            const code = await vfs.readTextFile(file);
            const lang = getLanguageIdFromPath(file);
            mockEl = containerEl.cloneNode(true) as HTMLElement;
            mockEl.className = "monaco-editor-prerender";
            mockEl.innerHTML = render(highlighter, {
              ...renderOptions,
              code,
              lang,
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
                renderOptions.filename === file &&
                renderOptions.code &&
                renderOptions.code !== model.getValue()
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
                throw new Error(`[vfs] Failed to open file: ${file}`);
              }
            }
          } else if ((renderOptions.code && (renderOptions.lang || renderOptions.filename))) {
            const model = monaco.editor.createModel(
              renderOptions.code,
              renderOptions.lang,
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
                const animate = mockEl.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 200 });
                if (animate) {
                  animate.finished.then(() => mockEl.remove());
                } else {
                  // don't support animation api
                  setTimeout(() => mockEl.remove(), 200);
                }
              }, 500);
            });
          }
          // load required grammars in background
          if (vfs) {
            const grammars = await getGrammarsInVFS(vfs);
            for (const name of grammars) {
              if (!highlighter.getLoadedLanguages().includes(name)) {
                await highlighter.loadLanguage(loadTMGrammer({ name }));
                shikiToMonaco(highlighter, monaco);
              }
            }
          }
        })();
      }
    },
  );
}

async function initRenderHighlighter(options: RenderOptions): Promise<HighlighterCore> {
  if (options.filename && !options.lang) {
    options.lang = getLanguageIdFromPath(options.filename);
  }
  const highlighter = await (ssrHighlighter ?? (ssrHighlighter = initShiki({
    theme: options.theme,
    preloadGrammars: options.lang ? [options.lang] : [],
  })));
  await Promise.all([
    () => {
      if (options.lang && !highlighter.getLoadedLanguages().includes(options.lang)) {
        return highlighter.loadLanguage(loadTMGrammer({ name: options.lang }));
      }
    },
    () => {
      if (options.theme && !highlighter.getLoadedThemes().includes(options.theme)) {
        return highlighter.loadLanguage(loadTMTheme(options.theme));
      }
    },
  ].map((fn) => fn()));
  return highlighter;
}

/** Render a read-only(mock) editor in HTML string. */
export async function renderToString(options: RenderOptions): Promise<string> {
  const highlighter = await initRenderHighlighter(options);
  return render(highlighter, options);
}

/** Render a `<monaco-editor>` component in HTML string. */
export async function renderToWebComponent(options: RenderOptions): Promise<string> {
  const highlighter = await initRenderHighlighter(options);
  const prerender = render(highlighter, options);
  return [
    `<monaco-editor>`,
    `<script type="application/json" class="monaco-editor-options">${JSON.stringify(options)}</script>`,
    `<div class="monaco-editor-prerender" style="width:100%;height:100%;">`,
    prerender,
    `</div>`,
    `</monaco-editor>`,
  ].join("");
}

export * from "./vfs";
