import type monacoNS from "monaco-editor-core";
import type { HighlighterCore } from "@shikijs/core";
import { shikiToMonaco } from "@shikijs/monaco";
import type { ShikiInitOptions } from "./shiki";
import { getGrammarsInVFS, getLanguageIdFromPath, initShiki } from "./shiki";
import { grammarRegistry, loadedGrammars, loadTMGrammer } from "./shiki";
import lspIndex, { createWorker, normalizeFormatOptions } from "./lsp/index";
import { renderMockEditor, type RenderOptions } from "./render";
import { VFS } from "./vfs";

const editorOptionKeys = [
  "autoDetectHighContrast",
  "automaticLayout",
  "contextmenu",
  "cursorBlinking",
  "detectIndentation",
  "extraEditorClassName",
  "fontFamily",
  "fontLigatures",
  "fontSize",
  "fontVariations",
  "fontWeight",
  "insertSpaces",
  "letterSpacing",
  "lineHeight",
  "lineNumbers",
  "linkedEditing",
  "minimap",
  "padding",
  "readOnly",
  "rulers",
  "scrollbar",
  "smoothScrolling",
  "tabIndex",
  "tabSize",
  "theme",
  "trimAutoWhitespace",
  "wordWrap",
  "wordWrapColumn",
  "wrappingIndent",
];

export interface InitOption extends ShikiInitOptions {
  vfs?: VFS;
  format?: Record<string, unknown>;
  compilerOptions?: Record<string, unknown>;
  importMap?: Record<string, unknown>;
  onWorkerMessage?: () => void;
}

/** Load the monaco editor and use shiki as the tokenizer. */
async function loadMonaco(highlighter: HighlighterCore, options?: InitOption) {
  const monaco = await import("./editor-core.js");
  const editorWorkerUrl = monaco.workerUrl();

  Reflect.set(globalThis, "MonacoEnvironment", {
    getWorker: async (_workerId: string, label: string) => {
      let url = editorWorkerUrl;
      let lsp = lspIndex[label];
      if (!lsp) {
        lsp = Object.values(lspIndex).find((lsp) => lsp.aliases?.includes(label));
      }
      if (lsp) {
        url = (await (lsp.import())).workerUrl();
      }
      const worker = await createWorker(url);
      if (!lsp) {
        const onMessage = () => {
          options?.onWorkerMessage?.();
          worker.removeEventListener("message", onMessage);
        };
        worker.addEventListener("message", onMessage);
      }
      return worker;
    },
    getLanguageIdFromUri: (uri: monacoNS.Uri) => getLanguageIdFromPath(uri.path),
  });

  const { vfs, compilerOptions, importMap } = options ?? {};
  if (compilerOptions) {
    Reflect.set(monaco.languages, "compilerOptions", compilerOptions);
  }
  if (importMap) {
    Reflect.set(monaco.languages, "importMapJSON", JSON.stringify(importMap));
  }
  if (vfs) {
    vfs._bindMonaco(monaco);
  }

  if (!document.getElementById("monaco-editor-core-css")) {
    const styleEl = document.createElement("style");
    styleEl.id = "monaco-editor-core-css";
    styleEl.media = "screen";
    // @ts-expect-error `_CSS` is defined at build time
    styleEl.textContent = monaco._CSS;
    document.head.appendChild(styleEl);
  }

  grammarRegistry.forEach(({ name: id, aliases }) => {
    monaco.languages.register({ id, aliases });
    monaco.languages.onLanguage(id, () => {
      if (!loadedGrammars.has(id)) {
        loadedGrammars.add(id);
        highlighter.loadLanguage(loadTMGrammer(id)).then(() => {
          // activate the highlighter for the language
          shikiToMonaco(highlighter, monaco);
        });
      }
      let label = id;
      let lsp = lspIndex[label];
      if (!lsp) {
        [label, lsp] = Object.entries(lspIndex).find(([, lsp]) => lsp.aliases?.includes(id));
      }
      if (lsp) {
        const formatOptions = normalizeFormatOptions(label, options?.format);
        lsp.import().then(({ setup }) => setup(id, monaco, formatOptions, vfs));
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
      const vfs = options.vfs;
      if (vfs) {
        const grammars = await getGrammarsInVFS(vfs);
        if (grammars.size > 0) {
          const preloadGrammars = options.preloadGrammars ?? (options.preloadGrammars = []);
          preloadGrammars.push(...grammars);
        }
      }
      const hightlighter = await initShiki(options);
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
  let workerPromise: Promise<void> | null = null;

  function loadMonacoCore(highlighter: HighlighterCore) {
    if (monacoCore) {
      return monacoCore;
    }
    let onWorkerMessage: (() => void) | undefined;
    workerPromise = new Promise<void>((resolve) => {
      onWorkerMessage = resolve;
    });
    return monacoCore = loadMonaco(highlighter, {
      ...options,
      onWorkerMessage,
    }).then((m) => monacoCore = m);
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
          const key = editorOptionKeys.find((k) => k.toLowerCase() === attrName);
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
          // we pass the `fontMaxDigitWidth` option to the editor as a
          // custom class name. this is used for keeping the line numbers
          // layout consistent between the SSR render and the client pre-render.
          if (opts.fontMaxDigitWidth) {
            opts.extraEditorClassName = [
              opts.extraEditorClassName,
              "font-max-digit-width-" +
              opts.fontMaxDigitWidth.toString().replace(".", "_"),
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

        // crreate a highlighter instance for the renderer/editor
        const preloadGrammars = options?.preloadGrammars ?? [];
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
        const highlighter = await initShiki({ ...options, preloadGrammars });

        // check the pre-rendered content, if not exists, render one
        let mockEl = this.querySelector<HTMLElement>(
          ".monaco-editor-prerender",
        );
        if (
          !mockEl &&
          ((file && vfs) || (renderOptions.code && renderOptions.lang))
        ) {
          let code = renderOptions.code;
          let lang = renderOptions.lang;
          if (vfs && file) {
            code = await vfs.readTextFile(file);
            lang = getLanguageIdFromPath(file);
          }
          mockEl = containerEl.cloneNode(true) as HTMLElement;
          mockEl.className = "monaco-editor-prerender";
          mockEl.innerHTML = renderMockEditor(highlighter, {
            ...renderOptions,
            lang,
            code,
          });
        }
        mockEl.style.position = "absolute";
        mockEl.style.top = "0";
        mockEl.style.left = "0";
        this.appendChild(mockEl);

        // load monaco editor
        (async () => {
          const monaco = await loadMonacoCore(highlighter);
          const editor = monaco.editor.create(containerEl, renderOptions);
          if (vfs && file) {
            const model = await vfs.openModel(file, editor);
            if (
              renderOptions.filename === file &&
              renderOptions.code &&
              renderOptions.code !== model.getValue()
            ) {
              // update the model value with the code from SSR
              model.setValue(renderOptions.code);
            }
          } else if ((renderOptions.code && renderOptions.lang)) {
            const model = monaco.editor.createModel(
              renderOptions.code,
              renderOptions.lang,
              // @ts-expect-error the overwrited `createModel` method supports
              // path as the third argument(URI)
              renderOptions.filename,
            );
            editor.setModel(model);
          }
          // hide the prerender element if exists
          if (mockEl && workerPromise) {
            workerPromise.then(() => {
              setTimeout(() => {
                const animate = mockEl.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 200 });
                if (animate) {
                  animate.finished.then(() => mockEl.remove());
                } else {
                  // don't support animation api
                  setTimeout(() => mockEl.remove(), 200);
                }
              }, 300);
            });
          }
          // load required grammars in background
          if (vfs) {
            const grammars = await getGrammarsInVFS(vfs);
            for (const grammar of grammars) {
              if (!loadedGrammars.has(grammar)) {
                loadedGrammars.add(grammar);
                await highlighter.loadLanguage(loadTMGrammer(grammar));
                shikiToMonaco(highlighter, monaco);
              }
            }
          }
        })();
      }
    },
  );
}

/** Render a monaco editor on the server side. */
export async function renderToString(options: RenderOptions): Promise<string> {
  if (options.filename && !options.lang) {
    options.lang = getLanguageIdFromPath(options.filename);
  }
  const highlighter = await (ssrHighlighter ?? (ssrHighlighter = initShiki({
    theme: options.theme,
    preloadGrammars: [options.lang],
  })));
  if (!loadedGrammars.has(options.lang)) {
    loadedGrammars.add(options.lang);
    await highlighter.loadLanguage(loadTMGrammer(options.lang));
  }
  return [
    `<monaco-editor>`,
    `<script type="application/json" class="monaco-editor-options">${JSON.stringify(options)}</script>`,
    `<div class="monaco-editor-prerender" style="width:100%;height:100%;">`,
    renderMockEditor(highlighter, options),
    `</div>`,
    `</monaco-editor>`,
  ].join("");
}

export { renderMockEditor, VFS };
