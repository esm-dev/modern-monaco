import type { InputBoxOptions, QuickPickOptions } from "monaco-editor-core";
import languageConfigurations from "vscode-language-configurations";
import { editor, languages, Uri } from "monaco-editor-core";
import { StandaloneServices } from "monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices.js";
import { IQuickInputService } from "monaco-editor-core/esm/vs/platform/quickinput/common/quickInput.js";

const quickInputService = StandaloneServices.get(IQuickInputService);
const defaultEditorOptions: editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  stickyScroll: { enabled: false },
  scrollBeyondLastLine: false,
  matchBrackets: "never",
  theme: "vitesse-dark",
};

// override monoaco editor APIs.
const { create, createModel, getModel } = editor;
Object.assign(editor, {
  create: (
    container: HTMLElement,
    options?: editor.IStandaloneEditorConstructionOptions,
  ): editor.IStandaloneCodeEditor => {
    return create(
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
      // @ts-expect-error `getLanguageIdFromUri` is added by esm-monaco
      language = MonacoEnvironment.getLanguageIdFromUri?.(uri);
    }
    return createModel(value, language, uri);
  },
  getModel: (uri: string | URL | Uri) => {
    return getModel(normalizeUri(uri));
  },
});

export function showInputBox(options: InputBoxOptions = {}) {
  const { placeHolder, title, value, password, ignoreFocusOut, validateInput } = options;
  const box = quickInputService.createInputBox();
  const validateValue = validateInput
    ? (value: string) => {
      const p = validateInput(value);
      if (p instanceof Promise) {
        box.busy = true;
        return p.then((v) => {
          box.busy = false;
          return v;
        });
      }
      return p;
    }
    : undefined;
  if (title) {
    box.title = title;
  }
  if (value) {
    box.value = value;
  }
  if (placeHolder) {
    box.placeholder = placeHolder;
  }
  if (password) {
    box.password = password;
  }
  if (ignoreFocusOut) {
    box.ignoreFocusOut = ignoreFocusOut;
  }
  if (validateInput) {
    box.onDidChangeValue(async (value: string) => {
      const validation = value ? await validateValue(value) : "";
      if (validation) {
        if (typeof validation === "string") {
          box.validationMessage = validation;
          box.severity = 3;
        } else {
          box.validationMessage = validation.message;
          box.severity = validation.severity;
        }
      } else {
        box.validationMessage = "";
        box.severity = 0;
      }
    });
  }
  box.show();
  return new Promise<string>((resolve) => {
    box.onDidAccept(async () => {
      if (!validateInput || !(await validateValue(box.value))) {
        resolve(box.value);
        box.dispose();
      }
    });
  });
}

export function showQuickPick(items: any[], options?: QuickPickOptions) {
  const pick = quickInputService.createQuickPick();
  console.log(pick);
  pick.show();
  return new Promise<any>((resolve) => {
    pick.onDidAccept(() => {
      resolve(pick.selectedItems[0]);
      pick.hide();
    });
  });
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
  // seems `colorizedBracketPairs` breaks embedded languages tokenization in html
  // let's remove it for now
  delete config.colorizedBracketPairs;
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

export * from "monaco-editor-core";
export { languageConfigurations };
