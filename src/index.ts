import type monacoNS from "monaco-editor-core";
import type { HighlighterCore } from "@shikijs/core";
import type { ShikiInitOptions } from "./shiki.ts";
import type { VFS } from "./vfs.ts";
import { shikiToMonaco } from "@shikijs/monaco";
import { createWorker, type LSPConfig, margeProviders } from "./lsp/index.ts";
import { render, type RenderOptions } from "./render.ts";
import { getLanguageIdFromPath, getLanguageIdsInVFS, initShiki } from "./shiki.ts";
import { loadTMGrammar, loadTMTheme, tmGrammars } from "./shiki.ts";

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
  "tabSize",
  "wordWrap",
];

export interface InitOption extends ShikiInitOptions {
  vfs?: VFS;
  lsp?: LSPConfig;
}

/** Load the monaco editor and use shiki as the tokenizer. */
async function loadMonaco(highlighter: HighlighterCore, options?: InitOption, onEditorWorkerReady?: () => void) {
  const monaco = await import("./editor-core.js");
  const editorWorkerUrl = monaco.getWorkerUrl();
  const vfs = options?.vfs;
  const lspProviders = margeProviders(options.lsp);

  if (!document.getElementById("monaco-editor-core-css")) {
    const styleEl = document.createElement("style");
    styleEl.id = "monaco-editor-core-css";
    styleEl.media = "screen";
    // @ts-expect-error `_CSS` is defined at build time
    styleEl.textContent = monaco._CSS;
    document.head.appendChild(styleEl);
  }

  Reflect.set(globalThis, "MonacoEnvironment", {
    workerProxies: {},
    onWorker: (languageId: string, workerProxy: () => any) => {
      const workerProxies = Reflect.get(MonacoEnvironment, "workerProxies");
      if (Array.isArray(workerProxies[languageId])) {
        workerProxies[languageId][0]();
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

  if (vfs) {
    vfs.bindMonaco(monaco);
  }

  const allLanguages = new Set([...tmGrammars.map(g => g.name), ...highlighter.getLoadedLanguages()]);
  allLanguages.forEach((id) => {
    monaco.languages.register({ id, aliases: tmGrammars.find(g => g.name === id)?.aliases });
    monaco.languages.onLanguage(id, () => {
      const config = monaco.languageConfigurations[monaco.languageConfigurationAliases[id] ?? id];
      if (config) {
        monaco.languages.setLanguageConfiguration(id, monaco.convertVscodeLanguageConfiguration(config));
      }
      if (!highlighter.getLoadedLanguages().includes(id)) {
        highlighter.loadLanguage(loadTMGrammar(id)).then(() => {
          // register tokenizer for the language
          shikiToMonaco(highlighter, monaco);
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
  shikiToMonaco(highlighter, monaco);

  return monaco;
}

let loading: Promise<typeof monacoNS> | undefined;
let ssrHighlighter: HighlighterCore | Promise<HighlighterCore> | undefined;

/* Initialize and return the monaco editor namespace. */
export function init(options: InitOption): Promise<typeof monacoNS> {
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
export function lazy(options?: InitOption) {
  const vfs = options?.vfs;
  const lspProviders = margeProviders(options.lsp);

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
        if (optionsScript && optionsScript.tagName === "SCRIPT" && optionsScript.type === "application/json") {
          const opts = JSON.parse(optionsScript.textContent);
          // we save the `fontDigitWidth` as a global variable, this is used for keeping the line numbers
          // layout consistent between the SSR render and the client pre-render.
          if (opts.fontDigitWidth) {
            Reflect.set(globalThis, "__monaco_maxDigitWidth", opts.fontDigitWidth);
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
        const langs = options?.langs ?? [];
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
          langs.push(renderOptions.lang ?? getLanguageIdFromPath(file));
        }
        for (const l of Object.values(lspProviders)) {
          if (l.syntaxes) {
            langs.push(...l.syntaxes);
          }
        }
        const highlighter = await initShiki({ ...options, langs });

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
            const ids = await getLanguageIdsInVFS(vfs);
            const loadedLangs = new Set(highlighter.getLoadedLanguages());
            Promise.all(
              ids.filter(name => !loadedLangs.has(name)).map(name =>
                highlighter.loadLanguage(loadTMGrammar(name)).then(() => shikiToMonaco(highlighter, monaco))
              ),
            );
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
    langs: options.lang ? [options.lang] : [],
  })));
  await Promise.all([
    () => {
      if (options.lang && !highlighter.getLoadedLanguages().includes(options.lang)) {
        return highlighter.loadLanguage(loadTMGrammar(options.lang));
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
