import { editor, languages, Uri } from "monaco-editor-core";

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

export const languageConfigurationAliases: Record<string, string> = {
  "jsx": "javascript",
  "tsx": "typescript",
};

export function convertVscodeLanguageConfiguration(config: any): languages.LanguageConfiguration {
  const { indentationRules, folding, wordPattern, onEnterRules } = config;
  if (folding?.markers) {
    fixRegexp(folding.markers, "start", "end");
  }
  if (wordPattern) {
    fixRegexp(config, "wordPattern");
  }
  if (indentationRules) {
    fixRegexp(
      indentationRules,
      "increaseIndentPattern",
      "decreaseIndentPattern",
      "indentNextLinePattern",
      "unIndentedLinePattern",
    );
  }
  if (onEnterRules) {
    for (const rule of onEnterRules) {
      fixRegexp(rule, "beforeText", "afterText", "previousLineText");
      if (typeof rule.action?.indent === "string") {
        rule.action.indentAction = ["none", "indent", "indentOutdent", "outdent"].indexOf(rule.action.indent);
        delete rule.action.indent;
      }
    }
  }
  return config;
}

function fixRegexp(obj: any, ...keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") {
      obj[key] = new RegExp(value);
    } else if (typeof value === "object" && value !== null && typeof value.pattern === "string") {
      obj[key] = new RegExp(value.pattern, value.flags);
    }
  }
}

export * from "monaco-editor-core";
export { default as languageConfigurations } from "vscode-language-configurations";
