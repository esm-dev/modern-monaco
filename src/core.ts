import type monacoNS from "monaco-editor-core";
import type { Highlighter, RenderOptions, ShikiInitOptions } from "./shiki.ts";
import type { LSPConfig, LSPProvider } from "./lsp/index.ts";
import { createMultiWorkspaceFileSystem, WorkspaceURI } from "./multi-workspace.ts";
import { WorkspaceInit, WorkspaceInitMultiple } from "../types/workspace";

import { parseImportMapFromJson } from "@esm.sh/import-map";
import { version } from "../package.json";

// ! external modules, don't remove the `.js` extension
import { getExtnameFromLanguageId, getLanguageIdFromPath, grammars, initShiki, setDefaultWasmLoader, themes } from "./shiki.js";
import { initShikiMonacoTokenizer, registerShikiMonacoTokenizer } from "./shiki.js";
import { render } from "./shiki.js";
import { getWasmInstance } from "./shiki-wasm.js";
import { ErrorNotFound, Workspace } from "./workspace.js";
import { debunce, decode, isDigital } from "./util.js";
import { init as initLspClient } from "./lsp/client.js";

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
  NotFound: ErrorNotFound,
};

const cdnUrl = `https://esm.sh/modern-monaco@${version}`;
const syntaxes: { name: string; scopeName: string }[] = [];
const lspProviders: Record<string, LSPProvider> = {};
const lspRegistrations = new Set<string>();

const attr = (el: HTMLElement, name: string): string | null => el.getAttribute(name);
const style = (el: HTMLElement, style: Partial<CSSStyleDeclaration>) => Object.assign(el.style, style);

export interface InitOptionsSingleWorkspace extends ShikiInitOptions {
  /**
     * Virtual file system to be used by the editor.
     */
  workspace?: Workspace<WorkspaceInit>;
  /**
    * Language server protocol configuration.
    */
  lsp?: LSPConfig;
}

export interface InitOptionsMultipleWorkspaces extends ShikiInitOptions {
  workspaces?: Workspace<WorkspaceInitMultiple>[];
  /**
  * Language server protocol configuration.
  */
  lsp?: LSPConfig;
}

export type InitOptions = InitOptionsSingleWorkspace | InitOptionsMultipleWorkspaces;



/** Initialize Monaco editor with optional multi-workspace support */
export async function init(options?: InitOptions): Promise<typeof monacoNS> {
  const langs = (options?.langs ?? []).concat(syntaxes as any[]);
  const highlighter = await initShiki({ ...options, langs });

  // Check if multi-workspace setup is requested
  if (options && 'workspaces' in options && options.workspaces) {
    return initMultiWorkspace(highlighter, options.workspaces, options.lsp);
  }

  // Single workspace setup
  const singleOptions = options as InitOptionsSingleWorkspace | undefined;
  return loadMonaco(highlighter, singleOptions?.workspace, singleOptions?.lsp);
}

/** Initialize multi-workspace Monaco setup */
async function initMultiWorkspace(
  highlighter: Highlighter,
  workspaces: Workspace<WorkspaceInitMultiple>[],
  lsp?: LSPConfig
): Promise<typeof monacoNS> {
  const multiWorkspaceFS = createMultiWorkspaceFileSystem(workspaces);
  const monaco = await loadMonaco(highlighter, multiWorkspaceFS as any, lsp);

  // Initialize each workspace with the Monaco instance
  workspaces.forEach(workspace => workspace.setupMonaco(monaco));

  return monaco;
}

/** Get Monaco instance, handling shared instances for multi-workspace */
async function getMonacoInstance(
  options: InitOptions | undefined,
  highlighter: Highlighter,
  workspace: Workspace<WorkspaceInit> | undefined,
  sharedPromise: Promise<typeof monacoNS> | null
): Promise<typeof monacoNS> {
  if (options && 'workspaces' in options && options.workspaces) {
    return sharedPromise || init(options);
  }
  return loadMonaco(highlighter, workspace, options?.lsp);
}

/** Render a mock editor, then load the monaco editor in background. */
export async function lazy(options?: InitOptions) {
  // Shared Monaco promise for all editors when using multiple workspaces
  let sharedMonacoPromise: Promise<typeof monacoNS> | null = null;

  if (!customElements.get("monaco-editor")) {
    customElements.define(
      "monaco-editor",
      class extends HTMLElement {
        async connectedCallback() {
          const workspaceName = this.getAttribute("workspace");
          let workspace: Workspace<WorkspaceInit> | undefined;
          if (options && 'workspaces' in options && options.workspaces) {
            workspace = options.workspaces.find((w) => w.name === workspaceName);
          } else {
            workspace = (options as InitOptionsSingleWorkspace | undefined)?.workspace;
          }
          const renderOptions: RenderOptions = {};

          // parse editor/render options from attributes
          for (const attrName of this.getAttributeNames()) {
            const key = editorProps.find((k) => k.toLowerCase() === attrName);
            if (key) {
              let value: any = attr(this, attrName);
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

          style(this, { display: "block", position: "relative" });

          // set dimension from width and height attributes
          let widthAttr = attr(this, "width");
          let heightAttr = attr(this, "height");
          if (isDigital(widthAttr) && isDigital(heightAttr)) {
            const width = Number(widthAttr);
            const height = Number(heightAttr);
            style(this, { width: width + "px", height: height + "px" });
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
          style(containerEl, { width: "100%", height: "100%" });
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
          if (renderOptions.theme) {
            renderOptions.theme = renderOptions.theme.toLowerCase().replace(/ +/g, "-");
          }

          const highlighter = await initShiki({
            ...options,
            theme: renderOptions.theme ?? options?.theme,
            langs,
          });

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
              if (error instanceof ErrorNotFound) {
                // ignore
              } else {
                throw error;
              }
            }
          }

          if (prerenderEl) {
            style(prerenderEl, { position: "absolute", top: "0", left: "0" });
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
            const monaco = await getMonacoInstance(options, highlighter, workspace, sharedMonacoPromise);
            if (options && 'workspaces' in options && options.workspaces && !sharedMonacoPromise) {
              sharedMonacoPromise = Promise.resolve(monaco);
            }
            const editor = monaco.editor.create(containerEl, renderOptions);
            if (workspace) {
              const storeViewState = () => {
                const currentModel = editor.getModel();
                if (currentModel?.uri.scheme === "file") {
                  const state = editor.saveViewState();
                  if (state) {
                    state.viewState.scrollTop ??= editor.getScrollTop();
                    // Strip workspace prefix for viewState storage to use original URI
                    const uri = currentModel.uri.toString();
                    const storageUri = WorkspaceURI.removeWorkspacePrefix(uri, workspace.name);
                    workspace.viewState.save(storageUri, Object.freeze(state));
                  }
                }
              };
              editor.onDidChangeCursorSelection(debunce(storeViewState, 500));
              editor.onDidScrollChange(debunce(storeViewState, 500));
              workspace.history.onChange((state) => {
                const currentModel = editor.getModel();
                if (currentModel) {
                  // Compare using the original URI (strip workspace prefix from current model)
                  const currentUri = currentModel.uri.toString();
                  const originalUri = WorkspaceURI.removeWorkspacePrefix(currentUri, workspace.name);

                  if (originalUri !== state.current) {
                    workspace._openTextDocument(state.current, editor);
                  }
                }
              });
            }
            if (filename && workspace) {
              try {
                const model = await workspace._openTextDocument(filename, editor);
                // update the model value with the SSR `code` if exists
                if (code && code !== model.getValue()) {
                  model.setValue(code);
                }
              } catch (error) {
                if (error instanceof ErrorNotFound) {
                  if (code) {
                    const dirname = filename.split("/").slice(0, -1).join("/");
                    if (dirname) {
                      await workspace.fs.createDirectory(dirname);
                    }
                    await workspace.fs.writeFile(filename, code);
                    workspace._openTextDocument(filename, editor);
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
              let modelUri = filename ? monaco.Uri.file(filename) : undefined;

              // Create workspace-scoped URI for non-default workspaces
              if (modelUri && workspace && workspace.name !== 'default') {
                const transformedPath = WorkspaceURI.addWorkspacePrefix(modelUri.path, workspace.name);
                modelUri = modelUri.with({ path: transformedPath });
              }

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

/** Load monaco editor core. */
async function loadMonaco(
  highlighter: Highlighter,
  workspace?: Workspace<WorkspaceInit>,
  lsp?: LSPConfig,
): Promise<typeof monacoNS> {
  let importmap: HTMLScriptElement | null = null;
  let editorCoreModuleUrl = `${cdnUrl}/es2022/editor-core.mjs`;
  let lspModuleUrl = `${cdnUrl}/es2022/lsp.mjs`;
  if (importmap = document.querySelector("script[type='importmap']")) {
    try {
      const { imports = {} } = parseImportMapFromJson(importmap.textContent);
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

  const builtinLSP = (globalThis as any).MonacoEnvironment?.builtinLSP;
  const [monaco, { builtinLSPProviders }]: [typeof import("./editor-core"), typeof import("./lsp")] = await Promise.all([
    import(editorCoreModuleUrl),
    builtinLSP ? import(lspModuleUrl) : Promise.resolve({ builtinLSPProviders: {} }),
  ]);
  const lspProviderMap = { ...builtinLSPProviders, ...lspProviders, ...lsp?.providers };

  // bind the monaco namespace to the workspace&lsp
  workspace?.setupMonaco(monaco);
  if (Object.keys(lspProviderMap).length > 0) {
    initLspClient(monaco);
  }

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
      if (workspace && resource.scheme === "file") {
        try {
          // Strip workspace prefix to get the original file URI
          const resourceUri = resource.toString();
          const originalUri = WorkspaceURI.removeWorkspacePrefix(resourceUri, workspace.name);
          await workspace._openTextDocument(originalUri, editor, selectionOrPosition);
          return true;
        } catch (err) {
          if (err instanceof ErrorNotFound) {
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

  // use the shiki as the tokenizer for the monaco editor
  const allLanguages = new Set(grammars.filter(g => !g.injectTo).map(g => g.name));
  allLanguages.forEach((id) => {
    const languages = monaco.languages;
    languages.register({ id, aliases: grammars.find(g => g.name === id)?.aliases });
    languages.onLanguage(id, async () => {
      const config = monaco.languageConfigurations[monaco.languageConfigurationAliases[id] ?? id];
      const loadedGrammars = new Set(highlighter.getLoadedLanguages());
      const reqiredGrammars = [id].concat(grammars.find(g => g.name === id)?.embedded ?? []).filter((id) => !loadedGrammars.has(id));
      if (config) {
        languages.setLanguageConfiguration(id, monaco.convertVscodeLanguageConfiguration(config));
      }
      if (reqiredGrammars.length > 0) {
        await highlighter.loadGrammarFromCDN(...reqiredGrammars);
      }

      // register the shiki tokenizer for the language
      registerShikiMonacoTokenizer(monaco, highlighter, id);

      // check if the language is supported by the LSP provider
      let lspLabel = id;
      let lspProvider = lspProviderMap[lspLabel];
      if (!lspProvider) {
        const alias = Object.entries(lspProviderMap).find(([, lsp]) => lsp.aliases?.includes(id));
        if (alias) {
          [lspLabel, lspProvider] = alias;
        }
      }
      if (lspProvider && workspace) {
        // Prevent duplicate language service registration in multi-workspace setups
        const registrationKey = `${id}-${workspace.name}`;
        if (!lspRegistrations.has(registrationKey)) {
          lspRegistrations.add(registrationKey);
          lspProvider.import().then(({ setup }) => setup(monaco, id, lsp?.[lspLabel], lsp?.formatting, workspace));
        }
      }
    });
  });

  // use shiki as the tokenizer of monaco editor
  initShikiMonacoTokenizer(monaco, highlighter);

  return monaco;
}

/** Register a custom language syntax. */
export function registerSyntax(syntax: { name: string; scopeName: string }) {
  syntaxes.push(syntax);
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

// set the shiki wasm default loader
setDefaultWasmLoader(getWasmInstance);

export { errors, Workspace };
