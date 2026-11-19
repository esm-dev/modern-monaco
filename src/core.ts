import type monacoNS from "monaco-editor-core";
import type { Highlighter, RenderOptions, ShikiInitOptions } from "./shiki.ts";
import type { LSPConfig, LSPProvider } from "./lsp/index.ts";
import { version } from "../package.json";

// ! external modules, don't remove the `.js` extension
import {
  ensureShikiResources,
  getExtnameFromLanguageId,
  getLanguageIdFromPath,
  grammars,
  initShiki,
  registerGrammarInfo,
  themes,
} from "./shiki.js";
import { initShikiMonacoTokenizer, registerShikiMonacoTokenizer } from "./shiki.js";
import { render } from "./shiki.js";
import { NotFoundError, Workspace } from "./workspace.js";
import { debunce, decode, isDigital } from "./util.js";

export interface InitOptions extends ShikiInitOptions {
  /**
   * Existing Shiki highlighter instance to share with the editor.
   */
  highlighter?: Highlighter;
  /**
   * Virtual file system to be used by the editor.
   */
  workspace?: Workspace;
  /**
   * Language server protocol configuration.
   */
  lsp?: LSPConfig;
}

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
  "theme",
  "wordWrap",
];

const errors = {
  NotFound: NotFoundError,
};

const syntaxes: { name: string; scopeName: string }[] = [];
const lspProviders: Record<string, LSPProvider> = {};

const getAttr = (el: HTMLElement, name: string): string | null => el.getAttribute(name);
const setStyle = (el: HTMLElement, style: Partial<CSSStyleDeclaration>) => Object.assign(el.style, style);

function resolveThemeName(theme: InitOptions["defaultTheme"]): string | undefined {
  if (typeof theme === "string") {
    return theme.replace(/\s+/g, "-").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  }
  if (theme && typeof theme === "object" && "name" in theme && typeof theme.name === "string") {
    return theme.name;
  }
  return undefined;
}

/* Initialize and return the monaco editor namespace. */
export async function init(options?: InitOptions): Promise<typeof monacoNS> {
  const langs = (options?.langs ?? []).concat(syntaxes as any[]);
  const shiki = options?.highlighter
    ? await ensureShikiResources(options.highlighter, { ...options, langs })
    : await initShiki({ ...options, langs });
  const defaultTheme = resolveThemeName(options?.theme ?? options?.defaultTheme);
  return loadMonaco(shiki, options?.workspace, options?.lsp, defaultTheme);
}

/** Render a mock editor, then load the monaco editor in background. */
export function lazy(options?: InitOptions) {
  if (!customElements.get("monaco-editor")) {
    let monacoPromise: Promise<typeof monacoNS> | null = null;
    customElements.define(
      "monaco-editor",
      class extends HTMLElement {
        async connectedCallback() {
          const workspace = options?.workspace;
          const renderOptions: RenderOptions = {};

          // parse editor/render options from attributes
          for (const attrName of this.getAttributeNames()) {
            const key = editorProps.find((k) => k.toLowerCase() === attrName);
            if (key) {
              let value: any = getAttr(this, attrName);
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

          let filename: string | undefined;
          let code: string | undefined;

          // get editor options from `<script class="monaco-editor-options" type="application/json">`
          const firstEl = this.firstElementChild;
          if (firstEl && firstEl.tagName === "SCRIPT" && firstEl.className === "monaco-editor-options") {
            try {
              const v = JSON.parse(firstEl.textContent!);
              if (Array.isArray(v) && v.length === 2) {
                const [input, opts] = v;
                Object.assign(renderOptions, opts);
                // we save the `fontDigitWidth` as a global variable, this is used for keeping the line numbers
                // layout consistent between the SSR render and the client pre-render.
                if (opts.fontDigitWidth) {
                  Reflect.set(globalThis, "__monaco_maxDigitWidth", opts.fontDigitWidth);
                }
                if (typeof input === "string") {
                  code = input;
                } else {
                  filename = input.filename;
                  code = input.code;
                }
              }
            } catch {
              // ignore
            }
            firstEl.remove();
          }

          setStyle(this, { display: "block", position: "relative" });

          // set dimension from width and height attributes
          let widthAttr = getAttr(this, "width");
          let heightAttr = getAttr(this, "height");
          if (isDigital(widthAttr) && isDigital(heightAttr)) {
            const width = Number(widthAttr);
            const height = Number(heightAttr);
            setStyle(this, { width: width + "px", height: height + "px" });
            renderOptions.dimension = { width, height };
          } else {
            if (isDigital(widthAttr)) {
              widthAttr += "px";
            }
            if (isDigital(heightAttr)) {
              heightAttr += "px";
            }
            this.style.width ||= widthAttr ?? "100%";
            this.style.height ||= heightAttr ?? "100%";
          }

          const containerEl = document.createElement("div");
          containerEl.className = "monaco-editor-container";
          setStyle(containerEl, { width: "100%", height: "100%" });
          this.appendChild(containerEl);

          if (!filename && workspace) {
            if (workspace.history.state.current) {
              filename = workspace.history.state.current;
            } else if (workspace.entryFile) {
              filename = workspace.entryFile;
              workspace.history.replace(filename);
            } else {
              const rootFiles = (await workspace.fs.readDirectory("/")).filter(([name, type]) => type === 1).map(([name]) => name);
              filename = rootFiles.includes("index.html") ? "index.html" : rootFiles[0];
              if (filename) {
                workspace.history.replace(filename);
              }
            }
          }

          const langs = (options?.langs ?? []).concat(syntaxes as any[]);
          if (renderOptions.language || filename) {
            const lang = renderOptions.language ?? getLanguageIdFromPath(filename!) ?? "plaintext";
            if (!syntaxes.find((s) => s.name === lang)) {
              langs.push(lang);
            }
          }

          let theme = options?.theme ?? options?.defaultTheme ?? renderOptions.theme;
          if (typeof theme === "string") {
            // fix theme ID
            theme = theme.toLowerCase().replace(/ +/g, "-");
          }

          // initialize or reuse shiki highlighter
          const highlighter = options?.highlighter
            ? await ensureShikiResources(options.highlighter, { ...options, theme, langs })
            : await initShiki({ ...options, theme, langs });

          // set the editor theme to shiki theme
          const defaultTheme = resolveThemeName(theme);
          renderOptions.theme = (defaultTheme && highlighter.getLoadedThemes().includes(defaultTheme))
            ? defaultTheme
            : highlighter.getLoadedThemes()[0];

          // check the pre-rendered editor, if not exists, render one
          let prerenderEl: HTMLElement | undefined;
          for (const el of this.children) {
            if (el.className === "monaco-editor-prerender") {
              prerenderEl = el as HTMLElement;
              break;
            }
          }

          if (!prerenderEl && filename && workspace) {
            try {
              const code = await workspace.fs.readFile(filename);
              const language = getLanguageIdFromPath(filename);
              prerenderEl = containerEl.cloneNode(true) as HTMLElement;
              prerenderEl.className = "monaco-editor-prerender";
              prerenderEl.innerHTML = render(highlighter, decode(code), { ...renderOptions, language });
            } catch (error) {
              if (error instanceof NotFoundError) {
                // ignore
              } else {
                throw error;
              }
            }
          }

          if (prerenderEl) {
            setStyle(prerenderEl, { position: "absolute", top: "0", left: "0" });
            this.appendChild(prerenderEl);
            if (filename && workspace) {
              const viewState = await workspace.viewState.get(filename);
              const scrollTop = viewState?.viewState.scrollTop ?? 0;
              if (scrollTop) {
                const mockEl = prerenderEl.querySelector(".mock-monaco-editor");
                if (mockEl) {
                  mockEl.scrollTop = scrollTop;
                }
              }
            }
          }

          // load and render editor
          {
            const monaco = await (monacoPromise ?? (monacoPromise = loadMonaco(highlighter, workspace, options?.lsp, renderOptions.theme)));
            const editor = monaco.editor.create(containerEl, renderOptions);
            if (workspace) {
              const storeViewState = () => {
                const currentModel = editor.getModel();
                if (currentModel?.uri.scheme === "file") {
                  const state = editor.saveViewState();
                  if (state) {
                    state.viewState.scrollTop ??= editor.getScrollTop();
                    workspace.viewState.save(currentModel.uri.toString(), Object.freeze(state));
                  }
                }
              };
              editor.onDidChangeCursorSelection(debunce(storeViewState, 500));
              editor.onDidScrollChange(debunce(storeViewState, 500));
              workspace.history.onChange((state) => {
                if (editor.getModel()?.uri.toString() !== state.current) {
                  workspace._openTextDocument(monaco, editor, state.current);
                }
              });
            }
            if (filename && workspace) {
              try {
                const model = await workspace._openTextDocument(monaco, editor, filename);
                // update the model value with the SSR `code` if exists
                if (code && code !== model.getValue()) {
                  model.setValue(code);
                }
              } catch (error) {
                if (error instanceof NotFoundError) {
                  if (code) {
                    const dirname = filename.split("/").slice(0, -1).join("/");
                    if (dirname) {
                      await workspace.fs.createDirectory(dirname);
                    }
                    await workspace.fs.writeFile(filename, code);
                    workspace._openTextDocument(monaco, editor, filename);
                  } else {
                    // open an empty model
                    editor.setModel(monaco.editor.createModel(""));
                  }
                } else {
                  throw error;
                }
              }
            } else if ((code && (renderOptions.language || filename))) {
              // Check if model already exists to prevent duplicate creation
              const modelUri = filename ? monaco.Uri.file(filename) : undefined;
              let model = modelUri ? monaco.editor.getModel(modelUri) : null;
              if (!model) {
                model = monaco.editor.createModel(code, renderOptions.language, modelUri);
              } else if (code !== model.getValue()) {
                // Update existing model with new code
                model.setValue(code);
              }
              editor.setModel(model);
            } else {
              // open an empty model
              editor.setModel(monaco.editor.createModel(""));
            }
            // hide the prerender element if exists
            if (prerenderEl) {
              setTimeout(() => {
                const animate = prerenderEl.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 200 });
                if (animate) {
                  animate.finished.then(() => prerenderEl.remove());
                } else {
                  // animation API is not supported
                  setTimeout(() => prerenderEl.remove(), 200);
                }
              }, 200);
            }
          }
        }
      },
    );
  }
}

/** Hydrate the monaco editor in the browser. */
export function hydrate(options?: InitOptions) {
  // currently, the `hydrate` function is just an alias of `lazy`
  return lazy(options);
}

let monacoInitialized = false;
let useBuiltinLSPFlag: boolean | undefined;
let activeHighlighter: Highlighter | undefined;
let activeWorkspace: Workspace | undefined;
let activeLsp: LSPConfig | undefined;
let activeLspProviders: Record<string, LSPProvider> = {};
const registeredLanguages = new Set<string>();
const activatedLanguages = new Set<string>();

/** Load monaco editor core. */
async function loadMonaco(
  highlighter: Highlighter,
  workspace?: Workspace,
  lsp?: LSPConfig,
  defaultTheme?: string,
): Promise<typeof monacoNS> {
  let cdnUrl = `https://esm.sh/modern-monaco@${version}`;
  let editorCoreModuleUrl = `${cdnUrl}/es2022/editor-core.mjs`;
  let lspModuleUrl = `${cdnUrl}/es2022/lsp.mjs`;

  let importmapEl: HTMLScriptElement | null = null;
  if (importmapEl = document.querySelector("script[type='importmap']")) {
    try {
      const { imports = {} } = JSON.parse(importmapEl.textContent);
      if (imports["modern-monaco/editor-core"]) {
        editorCoreModuleUrl = imports["modern-monaco/editor-core"];
      }
      if (imports["modern-monaco/lsp"]) {
        lspModuleUrl = imports["modern-monaco/lsp"];
      }
    } catch (error) {
      // ignore
    }
  }

  useBuiltinLSPFlag ??= Boolean((globalThis as any).MonacoEnvironment?.useBuiltinLSP);
  const [monaco, { builtinLSPProviders }]: [typeof import("./editor-core"), typeof import("./lsp")] = await Promise.all([
    import(/* webpackIgnore: true */ editorCoreModuleUrl),
    useBuiltinLSPFlag ? import(/* webpackIgnore: true */ lspModuleUrl) : Promise.resolve({ builtinLSPProviders: {} }),
  ]);
  const highlighterChanged = activeHighlighter !== undefined && activeHighlighter !== highlighter;
  activeHighlighter = highlighter;
  activeWorkspace = workspace;
  activeLsp = lsp;
  activeLspProviders = { ...builtinLSPProviders, ...lspProviders, ...lsp?.providers };

  // bind the monaco namespace to the workspace&lsp
  workspace?.setupMonaco(monaco);

  if (!monacoInitialized) {
    monacoInitialized = true;

    // apply the monaco CSS
    if (!document.getElementById("monaco-editor-core-css")) {
      const styleEl = document.createElement("style");
      styleEl.id = "monaco-editor-core-css";
      styleEl.media = "screen";
      // @ts-expect-error `monaco.cssBundle` is injected at build time
      styleEl.textContent = monaco.cssBundle;
      document.head.appendChild(styleEl);
    }

    // set the global `MonacoEnvironment` variable
    Reflect.set(globalThis, "MonacoEnvironment", {
      getWorker: async (_workerId: string, label: string) => {
        if (label === "editorWorkerService") {
          return monaco.createEditorWorkerMain();
        }
      },
      getLanguageIdFromUri: (uri: monacoNS.Uri) => getLanguageIdFromPath(uri.path),
      getExtnameFromLanguageId: getExtnameFromLanguageId,
    });

    // prevent to open a http link which is a model
    monaco.editor.registerLinkOpener({
      async open(link) {
        if ((link.scheme === "https" || link.scheme === "http") && monaco.editor.getModel(link)) {
          return true;
        }
        return false;
      },
    });

    // register the editor opener for the monaco editor
    monaco.editor.registerEditorOpener({
      openCodeEditor: async (editor, resource, selectionOrPosition) => {
        if (activeWorkspace && resource.scheme === "file") {
          try {
            await activeWorkspace._openTextDocument(monaco, editor, resource.toString(), selectionOrPosition);
            return true;
          } catch (err) {
            if (err instanceof NotFoundError) {
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
              if (pos) {
                const svp = editor.getScrolledVisiblePosition(new monaco.Position(pos.lineNumber - 7, pos.column));
                if (svp) {
                  editor.setScrollTop(svp.top);
                }
              }
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
  }

  // use shiki as the tokenizer for the monaco editor
  const allLanguages = new Set([
    ...grammars.filter((g) => !g.injectTo).map((g) => g.name),
    ...highlighter.getLoadedLanguages(),
  ]);
  allLanguages.forEach((id) => {
    if (registeredLanguages.has(id)) {
      if (highlighterChanged && activatedLanguages.has(id)) {
        registerShikiMonacoTokenizer(monaco, highlighter, id);
      }
      return;
    }
    registeredLanguages.add(id);
    const languages = monaco.languages;
    languages.register({ id, aliases: grammars.find((g) => g.name === id)?.aliases });
    languages.onLanguage(id, async () => {
      activatedLanguages.add(id);
      const currentHighlighter = activeHighlighter!;
      const config = monaco.languageConfigurations[monaco.languageConfigurationAliases[id] ?? id];
      const loadedGrammars = new Set(currentHighlighter.getLoadedLanguages());
      const reqiredGrammars = [id].concat(grammars.find((g) => g.name === id)?.embedded ?? []).filter((id) => !loadedGrammars.has(id));
      if (config) {
        languages.setLanguageConfiguration(id, monaco.convertVscodeLanguageConfiguration(config));
      }
      if (reqiredGrammars.length > 0) {
        await currentHighlighter.loadGrammarFromCDN(...reqiredGrammars);
      }

      // register the shiki tokenizer for the language
      registerShikiMonacoTokenizer(monaco, currentHighlighter, id);

      // check if the language is supported by the LSP provider
      let lspLabel = id;
      let lspProvider = activeLspProviders[lspLabel];
      if (!lspProvider) {
        const alias = Object.entries(activeLspProviders).find(([, lsp]) => lsp.aliases?.includes(id));
        if (alias) {
          [lspLabel, lspProvider] = alias;
        }
      }
      if (lspProvider) {
        lspProvider.import().then(({ setup }) => setup(monaco, id, activeLsp?.[lspLabel], activeLsp?.formatting, activeWorkspace));
      }
    });
  });

  // use shiki as the tokenizer of monaco editor
  initShikiMonacoTokenizer(monaco, highlighter, defaultTheme);

  return monaco;
}

/** Register a custom language syntax. */
export function registerSyntax(syntax: { name: string; scopeName: string; aliases?: string[] }) {
  syntaxes.push(syntax);
  registerGrammarInfo(syntax);
}

/** Register a custom theme. */
export function registerTheme(theme: Record<string, any>) {
  if (theme.name) {
    themes.set(theme.name, theme);
  }
}

/** Register a language server protocol provider. */
export function registerLSPProvider(lang: string, provider: LSPProvider) {
  lspProviders[lang] = provider;
}

export { errors, Workspace };
