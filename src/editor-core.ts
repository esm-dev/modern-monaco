import type { InputBoxOptions, QuickPickItem, QuickPickOptions } from "monaco-editor-core";
import { editor, languages, Uri } from "monaco-editor-core";
import { IQuickInputService } from "monaco-editor-core/esm/vs/platform/quickinput/common/quickInput.js";
import { StandaloneServices } from "monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices.js";
import languageConfigurations from "vscode-language-configurations";

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
      // @ts-expect-error `getLanguageIdFromUri` is injected by esm-monaco
      language = MonacoEnvironment.getLanguageIdFromUri?.(uri);
    }
    return createModel(value, language, uri);
  },
  getModel: (uri: string | URL | Uri) => {
    return getModel(normalizeUri(uri));
  },
});

export enum InputBoxValidationSeverity {
  Info = 1,
  Warning = 2,
  Error = 3,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

// showInputBox has same signature as vscode.window.showInputBox
// @see https://code.visualstudio.com/api/references/vscode-api#window.showInputBox
export function showInputBox(options: InputBoxOptions = {}) {
  const { placeHolder, title, value, password, ignoreFocusOut, validateInput } = options;
  const quickInputService = StandaloneServices.get(IQuickInputService);
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
    box.password = true;
  }
  if (ignoreFocusOut) {
    box.ignoreFocusOut = true;
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

// showQuickPick has same signature as vscode.window.showQuickPick
// @see https://code.visualstudio.com/api/references/vscode-api#window.showQuickPick
export function showQuickPick(items: any[], options: QuickPickOptions = {}) {
  const { placeHolder, title, ignoreFocusOut, matchOnDescription, matchOnDetail, canPickMany, onDidSelectItem } = options;
  const quickInputService = StandaloneServices.get(IQuickInputService);
  const pick = quickInputService.createQuickPick();
  if (title) {
    pick.title = title;
  }
  if (placeHolder) {
    pick.placeholder = placeHolder;
  }
  if (ignoreFocusOut) {
    pick.ignoreFocusOut = true;
  }
  if (matchOnDescription) {
    pick.matchOnDescription = true;
  }
  if (matchOnDetail) {
    pick.matchOnDetail = true;
  }
  if (canPickMany) {
    pick.canSelectMany = true;
  }
  if (items instanceof Promise) {
    pick.busy = true;
    items.then((items) => {
      pick.items = items.map(convertPickItem);
      pick.busy = false;
    });
  } else if (Array.isArray(items)) {
    pick.items = items.map(convertPickItem);
  }
  if (onDidSelectItem) {
    pick.onDidChangeActive((v) => {
      v.forEach((item) => {
        onDidSelectItem(convertPickItem(item?._kind_string ? item.label : item));
      });
    });
  }
  pick.show();
  return new Promise<any>((resolve) => {
    pick.onDidAccept(() => {
      if (canPickMany) {
        resolve(pick.selectedItems.map(item => item._kind_string ? item.label : item));
      } else {
        let selectedItem = pick.selectedItems[0];
        resolve(selectedItem?._kind_string ? selectedItem.label : selectedItem);
      }
      pick.dispose();
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

function convertPickItem(item: string | QuickPickItem) {
  if (typeof item === "string") {
    return { type: "item", label: item, _kind_string: true };
  }
  if (item.kind === QuickPickItemKind.Separator) {
    return { type: "separator", ...item };
  }
  return item;
}

export * from "monaco-editor-core";
export { languageConfigurations };
