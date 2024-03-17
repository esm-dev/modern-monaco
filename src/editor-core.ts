import { editor, Uri } from "monaco-editor-core";

export const defaultEditorOptions: editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  matchBrackets: "never",
  theme: "vitesse-dark",
};

const _create = editor.create;
const _createModel = editor.createModel;
const _getModel = editor.getModel;

// override some monaco editor inner methods
Object.assign(editor, {
  create: (
    container: HTMLElement,
    options?: editor.IStandaloneEditorConstructionOptions,
  ): editor.IStandaloneCodeEditor => {
    return _create(
      container,
      {
        ...defaultEditorOptions,
        ...options,
      } satisfies typeof options,
    );
  },
  createModel: (
    value: string,
    language?: string,
    uri?: string | URL | Uri,
  ) => {
    uri = normalizeUri(uri);
    if (!language && uri) {
      // @ts-ignore getLanguageIdFromUri added by esm-monaco
      language = MonacoEnvironment.getLanguageIdFromUri?.(uri);
    }
    return _createModel(value, language, uri);
  },
  getModel: (uri: string | URL | Uri) => {
    return _getModel(normalizeUri(uri));
  },
});

function normalizeUri(uri?: string | URL | Uri) {
  if (typeof uri === "string" || uri instanceof URL) {
    const url = new URL(uri, "file:///");
    uri = Uri.from({
      scheme: url.protocol.slice(0, -1),
      authority: url.host,
      path: url.pathname,
      query: url.search.slice(1),
      fragment: url.hash.slice(1),
    });
  }
  return uri;
}

export function getWorkerUrl() {
  const i = () => import("./editor-worker.js"); // trick for bundlers
  const m = getWorkerUrl.toString().match(/import\(['"](.+?)['"]\)/);
  if (!m) throw new Error("worker url not found", { cause: i });
  return new URL(m[1], import.meta.url);
}

export * from "monaco-editor-core";
