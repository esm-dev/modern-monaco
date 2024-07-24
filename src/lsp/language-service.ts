/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Je Xia <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type Monaco from "monaco-editor-core";
import type { VFS } from "~/vfs.ts";
import type { WorkerVFS } from "./worker-base.ts";
import * as lst from "vscode-languageserver-types";

// ! external modules, don't remove the `.js` extension
import { cache } from "../cache.js";

let monaco: typeof Monaco;
export function setup(monacoNS: typeof Monaco): void {
  monaco ??= monacoNS;
}

const registry: Map<string, Monaco.editor.MonacoWebWorker<any>> = new Map();
const registryListeners: Map<string, () => void> = new Map();
const refreshEmitters: Map<string, Monaco.Emitter<void>> = new Map();

/** refresh diagnostics for the specified language */
export function refreshDiagnostics(...langaugeIds: string[]) {
  langaugeIds.forEach((langaugeId) => {
    refreshEmitters.get(langaugeId)?.fire();
  });
}

/** create a worker host that reads content from the given VFS */
export function createVfsHost(vfs?: VFS) {
  return vfs
    ? {
      vfs_stat: async (uri: string) => {
        const file = await vfs.open(uri);
        return {
          type: 1,
          ctime: file.ctime,
          mtime: file.mtime,
          size: file.content.length,
        };
      },
      vfs_readTextFile: async (uri: string, encoding?: string): Promise<string> => {
        return vfs.readTextFile(uri);
      },
    }
    : undefined;
}

/** create a worker VFS from the given VFS */
export function createWorkerVFS(vfs?: VFS): Promise<WorkerVFS | undefined> {
  if (vfs) {
    return vfs.ls().then(files => ({ files }));
  }
  return undefined;
}

/** make a request to the language worker, cancelable by the token */
function lspRequest<Result>(req: () => Promise<Result>, token: Monaco.CancellationToken): Promise<Result | undefined> {
  if (!token) {
    return req();
  }
  return new Promise((resolve, reject) => {
    if (token.isCancellationRequested) {
      resolve(undefined);
      return;
    }
    token.onCancellationRequested(() => {
      resolve(undefined);
    });
    req().then(resolve, reject);
  });
}

// #region register basic language features

export function enableBasicFeatures<
  T extends
    & ILanguageWorkerWithValidation
    & ILanguageWorkerWithCompletions
    & ILanguageWorkerWithHover
    & ILanguageWorkerWithFormat
    & ILanguageWorkerWithRename
    & ILanguageWorkerWithDocumentSymbols
    & ILanguageWorkerWithDefinitions
    & ILanguageWorkerWithReferences
    & ILanguageWorkerWithDocumentHighlights
    & ILanguageWorkerWithFoldingRanges
    & ILanguageWorkerWithSelectionRanges
    & {
      removeDocumentCache(uri: string): Promise<void>;
      updateVFS(evt: { kind: "create" | "remove"; path: string }): Promise<void>;
    },
>(
  languageId: string,
  worker: Monaco.editor.MonacoWebWorker<T>,
  completionTriggerCharacters: string[],
  vfs?: VFS,
) {
  const { editor, languages } = monaco;

  // remove document cache from worker when the model is disposed
  const onDispose = async (model: Monaco.editor.ITextModel) => {
    const workerProxy = await worker.withSyncedResources([]);
    workerProxy.removeDocumentCache(model.uri.toString());
  };
  editor.onDidChangeModelLanguage(({ model, oldLanguage }) => {
    if (oldLanguage === languageId) {
      onDispose(model);
    }
  });
  editor.onWillDisposeModel((model) => {
    if (model.getLanguageId() === languageId) {
      onDispose(model);
    }
  });

  // enable diagnostics
  enableDiagnostics(languageId, worker);

  // register language features
  languages.registerCompletionItemProvider(languageId, new CompletionAdapter(worker, completionTriggerCharacters));
  languages.registerHoverProvider(languageId, new HoverAdapter(worker));
  languages.registerDocumentSymbolProvider(languageId, new DocumentSymbolAdapter(worker));
  languages.registerDefinitionProvider(languageId, new DefinitionAdapter(worker));
  languages.registerReferenceProvider(languageId, new ReferenceAdapter(worker));
  languages.registerRenameProvider(languageId, new RenameAdapter(worker));
  languages.registerDocumentFormattingEditProvider(languageId, new DocumentFormattingEditProvider(worker));
  languages.registerDocumentRangeFormattingEditProvider(languageId, new DocumentRangeFormattingEditProvider(worker));
  languages.registerFoldingRangeProvider(languageId, new FoldingRangeAdapter(worker));
  languages.registerDocumentHighlightProvider(languageId, new DocumentHighlightAdapter(worker));
  languages.registerSelectionRangeProvider(languageId, new SelectionRangeAdapter(worker));

  // add the worker to the registry
  registry.set(languageId, worker);
  if (registryListeners.has(languageId)) {
    registryListeners.get(languageId)();
    registryListeners.delete(languageId);
  }

  vfs?.watch("*", async (e) => {
    if (e.kind === "remove" || e.kind === "create") {
      const proxy = await worker.getProxy();
      await proxy.updateVFS({ kind: e.kind, path: e.path });
    }
  });
}

// #endregion

// #region EmbeddedLanguages

export interface ILanguageWorkerWithEmbeddedSupport {
  getEmbeddedDocument(uri: string, langaugeId: string): Promise<{ content: string } | null>;
}

export function attachEmbeddedLanguages<T extends ILanguageWorkerWithEmbeddedSupport>(
  languageId: string,
  mainWorker: Monaco.editor.MonacoWebWorker<T>,
  embeddedLanguages: string[],
) {
  const { editor, Uri } = monaco;
  const listeners = new Map<string, Monaco.IDisposable>();
  const validateModel = async (model: Monaco.editor.IModel) => {
    if (model.getLanguageId() !== languageId) {
      return;
    }
    const modelUri = model.uri.toString();
    const getEmbeddedDocument = async (rsl: string) => {
      const workerProxy = await mainWorker.withSyncedResources([model.uri]);
      return workerProxy.getEmbeddedDocument(modelUri, rsl);
    };
    const attachEmbeddedLanguage = async (languageId: string) => {
      const uri = Uri.parse(model.uri.path + getEmbeddedExtname(languageId));
      const doc = await getEmbeddedDocument(languageId);
      if (doc) {
        let embeddedModel = editor.getModel(uri);
        if (!embeddedModel) {
          embeddedModel = editor.createModel(doc.content, normalizeLanguageId(languageId), uri);
          Reflect.set(embeddedModel, "_versionId", model.getVersionId());
        } else {
          embeddedModel.setValue(doc.content);
        }
      } else {
        const embeddedModel = editor.getModel(uri);
        if (embeddedModel) {
          embeddedModel.dispose();
        }
      }
    };
    const attachAll = () => embeddedLanguages.forEach(attachEmbeddedLanguage);
    listeners.set(modelUri, model.onDidChangeContent(attachAll));
    attachAll();
  };
  const cleanUp = (model: Monaco.editor.IModel) => {
    const uri = model.uri.toString();
    if (listeners.has(uri)) {
      listeners.get(uri).dispose();
      listeners.delete(uri);
    }
    embeddedLanguages.forEach((languageId) => {
      const uri = Uri.parse(model.uri.path + getEmbeddedExtname(languageId));
      editor.getModel(uri)?.dispose();
    });
  };
  editor.onDidCreateModel(validateModel);
  editor.onWillDisposeModel((model) => {
    if (model.getLanguageId() === languageId) {
      cleanUp(model);
    }
  });
  editor.onDidChangeModelLanguage(({ model, oldLanguage }) => {
    if (oldLanguage === languageId) {
      cleanUp(model);
    }
    validateModel(model);
  });
  editor.getModels().forEach(validateModel);
  embeddedLanguages.forEach((id) => {
    onWorker(normalizeLanguageId(id), () => {
      refreshDiagnostics(languageId);
    });
  });
}

export function createWorkerWithEmbeddedLanguages<T extends ILanguageWorkerWithEmbeddedSupport>(
  mainWorker: Monaco.editor.MonacoWebWorker<T>,
): Monaco.editor.MonacoWebWorker<T> {
  const redirectLSPRequest = async (rsl: string, method: string, uri: string, ...args: any[]) => {
    const langaugeId = normalizeLanguageId(rsl);
    const worker = registry.get(langaugeId);
    if (worker) {
      const embeddedUri = monaco.Uri.parse(uri + getEmbeddedExtname(rsl));
      return worker.withSyncedResources([embeddedUri]).then(worker => worker[method]?.(embeddedUri.toString(), ...args));
    }
    return null;
  };
  return {
    withSyncedResources: async (resources: Monaco.Uri[]) => {
      const workerProxy = await mainWorker.withSyncedResources(resources);
      return new Proxy(workerProxy, {
        get(target, prop, receiver) {
          const value: any = Reflect.get(target, prop, receiver);
          if (typeof value === "function") {
            return async (uri: string, ...args: any[]) => {
              const ret = await value(uri, ...args);
              if (typeof ret === "object" && ret != null && !Array.isArray(ret) && "$embedded" in ret) {
                const embedded = ret.$embedded;
                if (typeof embedded === "string") {
                  return redirectLSPRequest(embedded, prop as string, uri, ...args);
                } else if (typeof embedded === "object" && embedded != null) {
                  const { languageIds, data, origin } = embedded;
                  const promises = languageIds.map((rsl: string, i: number) =>
                    redirectLSPRequest(rsl, prop as string, uri, ...args, data?.[i])
                  );
                  const results = await Promise.all(promises);
                  return origin.concat(...results.filter((r) => Array.isArray(r)));
                }
                return null;
              }
              return ret;
            };
          }
          return value;
        },
      });
    },
    dispose: () => {
      mainWorker.dispose();
    },
    getProxy: () => {
      throw new Error("Method not implemented.");
    },
  };
}

function onWorker(languageId: string, cb: () => void) {
  if (registry.has(languageId)) {
    cb();
  } else {
    registryListeners.set(languageId, cb);
  }
}

function normalizeLanguageId(languageId: string): string {
  return languageId === "importmap" ? "json" : languageId;
}

function getEmbeddedExtname(rsl: string): string {
  return ".(embedded)." + (rsl === "javascript" ? "js" : rsl);
}

// #endregion

// #region Diagnostics

export interface ILanguageWorkerWithValidation {
  doValidation(uri: string): Promise<lst.Diagnostic[] | null>;
}

function enableDiagnostics<T extends ILanguageWorkerWithValidation>(
  languageId: string,
  worker: Monaco.editor.MonacoWebWorker<T>,
) {
  const { editor, Emitter } = monaco;
  const refreshEmitter = new Emitter<void>();
  const listeners = new Map<string, Monaco.IDisposable>();
  const doValidate = async (model: Monaco.editor.ITextModel) => {
    const workerProxy = await worker.withSyncedResources([model.uri]);
    const diagnostics = await workerProxy.doValidation(model.uri.toString());
    if (diagnostics && !model.isDisposed()) {
      const markers = diagnostics.map(diagnosticToMarker);
      monaco.editor.setModelMarkers(model, languageId, markers);
    }
  };
  const validateModel = (model: Monaco.editor.IModel): void => {
    const modelLanugageId = model.getLanguageId();
    const uri = model.uri.toString();
    if (modelLanugageId !== languageId || uri.includes(".(embedded).")) {
      return;
    }

    let timer: number | null = null;
    const reValidate = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        doValidate(model);
      }, 500);
    };

    listeners.set(uri, model.onDidChangeContent(reValidate));
    doValidate(model);
  };
  const dispose = (model: Monaco.editor.IModel): void => {
    const uri = model.uri.toString();
    if (listeners.has(uri)) {
      listeners.get(uri).dispose();
      listeners.delete(uri);
    }
  };

  editor.onDidCreateModel(validateModel);
  editor.onWillDisposeModel((model) => {
    if (model.getLanguageId() === languageId) {
      dispose(model);
    }
    editor.setModelMarkers(model, languageId, []);
  });
  editor.onDidChangeModelLanguage(({ model, oldLanguage }) => {
    if (oldLanguage === languageId) {
      dispose(model);
    }
    validateModel(model);
  });
  editor.getModels().forEach(validateModel);

  // refresh diagnostics on event
  refreshEmitter.event(() => {
    editor.getModels().forEach((model) => {
      if (model.getLanguageId() === languageId) {
        dispose(model);
      }
      validateModel(model);
    });
  });
  refreshEmitters.set(languageId, refreshEmitter);
}

function diagnosticToMarker(diag: lst.Diagnostic): Monaco.editor.IMarkerData {
  const { range, severity, code, message, source, tags, relatedInformation } = diag;
  const { start, end } = range;
  return {
    startLineNumber: start.line + 1,
    startColumn: start.character + 1,
    endLineNumber: end.line + 1,
    endColumn: end.character + 1,
    severity: convertSeverity(severity),
    code: typeof code === "number" ? String(code) : code,
    message,
    source,
    tags,
    relatedInformation: relatedInformation?.map(convertRelatedInformation),
  };
}

function convertSeverity(lsSeverity: number | undefined): Monaco.MarkerSeverity {
  switch (lsSeverity) {
    case lst.DiagnosticSeverity.Error:
      return monaco.MarkerSeverity.Error;
    case lst.DiagnosticSeverity.Warning:
      return monaco.MarkerSeverity.Warning;
    case lst.DiagnosticSeverity.Information:
      return monaco.MarkerSeverity.Info;
    case lst.DiagnosticSeverity.Hint:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Info;
  }
}

function convertRelatedInformation(info: lst.DiagnosticRelatedInformation): Monaco.editor.IRelatedInformation {
  const { location: { uri, range }, message } = info;
  const { start, end } = range;
  return {
    resource: monaco.Uri.parse(uri),
    startLineNumber: start.line + 1,
    startColumn: start.character + 1,
    endLineNumber: end.line + 1,
    endColumn: end.character + 1,
    message: message,
  };
}

// #endregion

// #region CompletionAdapter

export interface ILanguageWorkerWithCompletions {
  doComplete(uri: string, position: lst.Position): Promise<lst.CompletionList | null>;
  doResolveCompletionItem?(item: lst.CompletionItem): Promise<lst.CompletionItem | null>;
}

export class CompletionAdapter<T extends ILanguageWorkerWithCompletions> implements Monaco.languages.CompletionItemProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
    private readonly _triggerCharacters: string[],
  ) {}

  get triggerCharacters(): string[] {
    return this._triggerCharacters;
  }

  async provideCompletionItems(
    model: Monaco.editor.IReadOnlyModel,
    position: Monaco.Position,
    context: Monaco.languages.CompletionContext,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.CompletionList | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const info = await lspRequest(() => worker?.doComplete(model.uri.toString(), fromPosition(position)), token);
    if (!info) {
      return;
    }
    const wordInfo = model.getWordUntilPosition(position);
    const wordRange = new monaco.Range(
      position.lineNumber,
      wordInfo.startColumn,
      position.lineNumber,
      wordInfo.endColumn,
    );
    const items: Monaco.languages.CompletionItem[] = info.items.map((entry) => {
      const item: Monaco.languages.CompletionItem & { data?: any } = {
        command: entry.command && convertCommand(entry.command),
        data: entry.data,
        detail: entry.detail,
        documentation: entry.documentation,
        filterText: entry.filterText,
        insertText: entry.insertText || entry.label,
        kind: convertCompletionItemKind(entry.kind),
        label: entry.label,
        range: wordRange,
        sortText: entry.sortText,
        tags: entry.tags,
      };
      if (entry.textEdit) {
        if (isInsertReplaceEdit(entry.textEdit)) {
          item.range = {
            insert: convertRange(entry.textEdit.insert),
            replace: convertRange(entry.textEdit.replace),
          };
        } else {
          item.range = convertRange(entry.textEdit.range);
        }
        item.insertText = entry.textEdit.newText;
      }
      if (entry.additionalTextEdits) {
        item.additionalTextEdits = entry.additionalTextEdits.map<Monaco.languages.TextEdit>(convertTextEdit);
      }
      if (entry.insertTextFormat === lst.InsertTextFormat.Snippet) {
        item.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
      }
      return item;
    });

    return {
      suggestions: items,
      incomplete: info.isIncomplete,
    };
  }

  async resolveCompletionItem(
    item: Monaco.languages.CompletionItem & { data?: any },
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.CompletionItem | undefined> {
    if (item.data?.context) {
      const { languageId } = item.data.context;
      const worker = registry.get(languageId);
      if (worker) {
        const workerProxy = await lspRequest<ILanguageWorkerWithCompletions>(() => worker.withSyncedResources([]), token);
        const details = await lspRequest(() => workerProxy?.doResolveCompletionItem?.(item as unknown as lst.CompletionItem), token);
        if (details) {
          item.detail = details.detail;
          item.documentation = details.documentation;
          item.additionalTextEdits = details.additionalTextEdits?.map(convertTextEdit);
        }
      }
    } else {
      const worker = await lspRequest(() => this._worker.withSyncedResources([]), token);
      const details = await lspRequest(() => worker?.doResolveCompletionItem?.(item as unknown as lst.CompletionItem), token);
      if (details) {
        item.detail = details.detail;
        item.documentation = details.documentation;
        item.additionalTextEdits = details.additionalTextEdits?.map(convertTextEdit);
      }
    }
    return item;
  }
}

export function fromPosition(position: Monaco.Position): lst.Position;
export function fromPosition(position: undefined): undefined;
export function fromPosition(position: Monaco.Position | undefined): lst.Position | undefined {
  if (!position) {
    return undefined;
  }
  return { character: position.column - 1, line: position.lineNumber - 1 };
}

export function fromRange(range: Monaco.IRange): lst.Range;
export function fromRange(range: undefined): undefined;
export function fromRange(range: Monaco.IRange | undefined): lst.Range | undefined {
  if (!range) {
    return undefined;
  }
  return {
    start: {
      line: range.startLineNumber - 1,
      character: range.startColumn - 1,
    },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

export function convertRange(range: lst.Range): Monaco.Range;
export function convertRange(range: undefined): undefined;
export function convertRange(range: lst.Range | undefined): Monaco.Range | undefined {
  if (!range) {
    return undefined;
  }
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

function isInsertReplaceEdit(
  edit: lst.TextEdit | lst.InsertReplaceEdit,
): edit is lst.InsertReplaceEdit {
  return (
    typeof (<lst.InsertReplaceEdit> edit).insert !== "undefined" && typeof (<lst.InsertReplaceEdit> edit).replace !== "undefined"
  );
}

function convertCompletionItemKind(
  kind: lst.CompletionItemKind | undefined,
): Monaco.languages.CompletionItemKind {
  const CompletionItemKind = monaco.languages.CompletionItemKind;
  switch (kind) {
    case lst.CompletionItemKind.Text:
      return CompletionItemKind.Text;
    case lst.CompletionItemKind.Method:
      return CompletionItemKind.Method;
    case lst.CompletionItemKind.Function:
      return CompletionItemKind.Function;
    case lst.CompletionItemKind.Constructor:
      return CompletionItemKind.Constructor;
    case lst.CompletionItemKind.Field:
      return CompletionItemKind.Field;
    case lst.CompletionItemKind.Variable:
      return CompletionItemKind.Variable;
    case lst.CompletionItemKind.Class:
      return CompletionItemKind.Class;
    case lst.CompletionItemKind.Interface:
      return CompletionItemKind.Interface;
    case lst.CompletionItemKind.Module:
      return CompletionItemKind.Module;
    case lst.CompletionItemKind.Property:
      return CompletionItemKind.Property;
    case lst.CompletionItemKind.Unit:
      return CompletionItemKind.Unit;
    case lst.CompletionItemKind.Value:
      return CompletionItemKind.Value;
    case lst.CompletionItemKind.Enum:
      return CompletionItemKind.Enum;
    case lst.CompletionItemKind.Keyword:
      return CompletionItemKind.Keyword;
    case lst.CompletionItemKind.Snippet:
      return CompletionItemKind.Snippet;
    case lst.CompletionItemKind.Color:
      return CompletionItemKind.Color;
    case lst.CompletionItemKind.File:
      return CompletionItemKind.File;
    case lst.CompletionItemKind.Reference:
      return CompletionItemKind.Reference;
    case lst.CompletionItemKind.Folder:
      return CompletionItemKind.Folder;
    case lst.CompletionItemKind.EnumMember:
      return CompletionItemKind.EnumMember;
    case lst.CompletionItemKind.Constant:
      return CompletionItemKind.Constant;
    case lst.CompletionItemKind.Struct:
      return CompletionItemKind.Struct;
    case lst.CompletionItemKind.Event:
      return CompletionItemKind.Event;
    case lst.CompletionItemKind.Operator:
      return CompletionItemKind.Operator;
    case lst.CompletionItemKind.TypeParameter:
      return CompletionItemKind.TypeParameter;
    default:
      return undefined;
  }
}

export function convertTextEdit(textEdit: lst.TextEdit): Monaco.languages.TextEdit;
export function convertTextEdit(textEdit: undefined): undefined;
export function convertTextEdit(textEdit: lst.TextEdit | undefined): Monaco.languages.TextEdit | undefined {
  if (!textEdit) {
    return undefined;
  }
  return {
    range: convertRange(textEdit.range),
    text: textEdit.newText,
  };
}

function convertCommand(c: lst.Command | undefined): Monaco.languages.Command | undefined {
  return c ? { id: c.command ?? Reflect.get(c, "id"), title: c.title, arguments: c.arguments } : undefined;
}

// #endregion

// #region HoverAdapter

export interface ILanguageWorkerWithHover {
  doHover(uri: string, position: lst.Position): Promise<lst.Hover | null>;
}

export class HoverAdapter<T extends ILanguageWorkerWithHover> implements Monaco.languages.HoverProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideHover(
    model: Monaco.editor.IReadOnlyModel,
    position: Monaco.Position,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.Hover | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const info = await lspRequest(() => worker?.doHover(model.uri.toString(), fromPosition(position)), token);
    if (info) {
      return {
        range: convertRange(info.range),
        contents: convertMarkedStringArray(info.contents),
      };
    }
  }
}

function isMarkupContent(v: any): v is lst.MarkupContent {
  return (v && typeof v === "object" && typeof (<lst.MarkupContent> v).kind === "string");
}

function convertMarkdownString(entry: lst.MarkupContent | lst.MarkedString): Monaco.IMarkdownString {
  if (typeof entry === "string") {
    return { value: entry };
  }
  if (isMarkupContent(entry)) {
    if (entry.kind === "plaintext") {
      return { value: entry.value.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&") };
    }
    return { value: entry.value };
  }
  return { value: "```" + entry.language + "\n" + entry.value + "\n```\n" };
}

function convertMarkedStringArray(
  contents: lst.MarkupContent | lst.MarkupContent[] | lst.MarkedString | lst.MarkedString[],
): Monaco.IMarkdownString[] | undefined {
  if (!contents) {
    return undefined;
  }
  if (Array.isArray(contents)) {
    return contents.map(convertMarkdownString);
  }
  return [convertMarkdownString(contents)];
}

// #endregion

// #region SignatureHelpAdapter

interface ILanguageWorkerWithSignatureHelp {
  doSignatureHelp(
    uri: string,
    position: number,
    context: Monaco.languages.SignatureHelpContext,
  ): Promise<lst.SignatureHelp | null>;
}

export function enableSignatureHelp<T extends ILanguageWorkerWithSignatureHelp>(
  languageId: string,
  worker: Monaco.editor.MonacoWebWorker<T>,
  triggerCharacters: string[],
) {
  monaco.languages.registerSignatureHelpProvider(
    languageId,
    new SignatureHelpAdapter(worker, triggerCharacters),
  );
}

export class SignatureHelpAdapter<T extends ILanguageWorkerWithSignatureHelp> implements Monaco.languages.SignatureHelpProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
    private readonly _triggerCharacters: string[],
  ) {}

  get signatureHelpTriggerCharacters() {
    return this._triggerCharacters;
  }

  async provideSignatureHelp(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
    token: Monaco.CancellationToken,
    context: Monaco.languages.SignatureHelpContext,
  ): Promise<Monaco.languages.SignatureHelpResult | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const helpInfo = await lspRequest(() => worker?.doSignatureHelp(model.uri.toString(), model.getOffsetAt(position), context), token);
    if (!helpInfo || model.isDisposed()) {
      return undefined;
    }
    helpInfo.signatures?.forEach(s => {
      if (typeof s.documentation === "string") {
        s.documentation = { kind: "markdown", value: s.documentation };
      }
    });
    return {
      value: <Monaco.languages.SignatureHelp> helpInfo,
      dispose() {},
    };
  }
}

// #endregion

// #region CodeActionAdapter

export interface ILanguageWorkerWithCodeAction {
  doCodeAction(
    uri: string,
    range: lst.Range,
    context: lst.CodeActionContext,
    formatOptions: lst.FormattingOptions,
  ): Promise<lst.CodeAction[] | null>;
}

export function enableCodeAction<T extends ILanguageWorkerWithCodeAction>(
  languageId: string,
  worker: Monaco.editor.MonacoWebWorker<T>,
) {
  monaco.languages.registerCodeActionProvider(languageId, new CodeActionAdaptor(worker));
}

export class CodeActionAdaptor<T extends ILanguageWorkerWithCodeAction> implements Monaco.languages.CodeActionProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  public async provideCodeActions(
    model: Monaco.editor.ITextModel,
    range: Monaco.Range,
    context: Monaco.languages.CodeActionContext,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.CodeActionList | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const codeActions = await lspRequest(
      () => {
        const modelOptions = model.getOptions();
        const formatOptions: lst.FormattingOptions = {
          tabSize: modelOptions.tabSize,
          insertSpaces: modelOptions.insertSpaces,
          trimTrailingWhitespace: modelOptions.trimAutoWhitespace,
        };
        return worker.doCodeAction(model.uri.toString(), fromRange(range), fromCodeActionContext(context), formatOptions);
      },
      token,
    );
    if (codeActions) {
      return {
        actions: codeActions.map(action => ({
          kind: action.kind ?? "quickfix",
          title: action.title,
          edit: action.edit && convertWorkspaceEdit(action.edit),
          diagnostics: context.markers,
          command: action.command && convertCommand(action.command),
        })),
        dispose: () => {},
      };
    }
  }
}

function fromCodeActionContext(context: Monaco.languages.CodeActionContext): lst.CodeActionContext {
  return {
    diagnostics: context.markers.map(fromMarkerToDiagnostic),
    only: [context.only],
    triggerKind: context.trigger,
  };
}

function fromMarkerToDiagnostic(marker: Monaco.editor.IMarkerData): lst.Diagnostic {
  return {
    code: typeof marker.code === "string" ? marker.code : marker.code?.value,
    message: marker.message,
    range: fromRange(marker),
    severity: fromDiagnosticSeverity(marker.severity),
    source: marker.source,
    tags: marker.tags,
  };
}

function fromDiagnosticSeverity(severity: Monaco.MarkerSeverity): lst.DiagnosticSeverity {
  switch (severity) {
    case monaco.MarkerSeverity.Error:
      return lst.DiagnosticSeverity.Error;
    case monaco.MarkerSeverity.Warning:
      return lst.DiagnosticSeverity.Warning;
    case monaco.MarkerSeverity.Hint:
      return lst.DiagnosticSeverity.Hint;
    default:
      return lst.DiagnosticSeverity.Information;
  }
}

// #endregion

// #region RenameAdapter

export interface ILanguageWorkerWithRename {
  doRename(uri: string, position: lst.Position, newName: string): Promise<lst.WorkspaceEdit | null>;
}

export class RenameAdapter<T extends ILanguageWorkerWithRename> implements Monaco.languages.RenameProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideRenameEdits(
    model: Monaco.editor.IReadOnlyModel,
    position: Monaco.Position,
    newName: string,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.WorkspaceEdit | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const edit = await lspRequest(() => worker?.doRename(model.uri.toString(), fromPosition(position), newName), token);
    if (edit) {
      return convertWorkspaceEdit(edit);
    }
  }
}

function convertWorkspaceEdit(edit: lst.WorkspaceEdit): Monaco.languages.WorkspaceEdit | undefined {
  if (!edit.changes) {
    return undefined;
  }
  let resourceEdits: Monaco.languages.IWorkspaceTextEdit[] = [];
  for (let uri in edit.changes) {
    const resource = monaco.Uri.parse(uri);
    for (let change of edit.changes[uri]) {
      resourceEdits.push({
        resource,
        versionId: undefined,
        textEdit: {
          range: convertRange(change.range),
          text: change.newText,
        },
      });
    }
  }
  return { edits: resourceEdits };
}

// #endregion

// #region DocumentFormattingEditProvider, DocumentRangeFormattingEditProvider

export interface ILanguageWorkerWithFormat {
  doFormat(
    uri: string,
    range: lst.Range | null,
    options: lst.FormattingOptions,
    docText?: string,
  ): Promise<lst.TextEdit[] | null>;
}

export class DocumentFormattingEditProvider<T extends ILanguageWorkerWithFormat>
  implements Monaco.languages.DocumentFormattingEditProvider
{
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideDocumentFormattingEdits(
    model: Monaco.editor.IReadOnlyModel,
    options: Monaco.languages.FormattingOptions,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.TextEdit[] | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const edits = await lspRequest(() => worker?.doFormat(model.uri.toString(), null, options as lst.FormattingOptions), token);
    if (edits) {
      return edits.map<Monaco.languages.TextEdit>(convertTextEdit);
    }
  }
}

export class DocumentRangeFormattingEditProvider<T extends ILanguageWorkerWithFormat>
  implements Monaco.languages.DocumentRangeFormattingEditProvider
{
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideDocumentRangeFormattingEdits(
    model: Monaco.editor.IReadOnlyModel,
    range: Monaco.Range,
    options: Monaco.languages.FormattingOptions,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.TextEdit[] | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const edits = await lspRequest(() => worker?.doFormat(model.uri.toString(), fromRange(range), options as lst.FormattingOptions), token);
    if (edits) {
      return edits.map<Monaco.languages.TextEdit>(convertTextEdit);
    }
  }
}

// #endregion

// #region AutoComplete

export interface ILanguageWorkerWithAutoComplete {
  doAutoComplete(uri: string, position: lst.Position, ch: string): Promise<string | null>;
}

export function enableAutoComplete<T extends ILanguageWorkerWithAutoComplete>(
  langaugeId: string,
  worker: Monaco.editor.MonacoWebWorker<T>,
  triggerCharacters: string[],
) {
  const { editor } = monaco;
  const listeners = new Map<string, Monaco.IDisposable>();
  const validateModel = async (model: Monaco.editor.IModel) => {
    if (model.getLanguageId() !== langaugeId) {
      return;
    }
    const modelUri = model.uri.toString();
    listeners.set(
      modelUri,
      model.onDidChangeContent(async (e: Monaco.editor.IModelContentChangedEvent) => {
        const lastChange = e.changes[e.changes.length - 1];
        const lastCharacter = lastChange.text[lastChange.text.length - 1];
        if (triggerCharacters.includes(lastCharacter)) {
          const lastRange = lastChange.range;
          const position = new monaco.Position(lastRange.endLineNumber, lastRange.endColumn + lastChange.text.length);
          const workerProxy = await worker.withSyncedResources([model.uri]);
          const snippet = await workerProxy.doAutoComplete(modelUri, fromPosition(position), lastCharacter);
          if (snippet) {
            const cursor = snippet.indexOf("$0");
            const insertText = cursor >= 0 ? snippet.replace("$0", "") : snippet;
            const range = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
            model.pushEditOperations([], [{ range, text: insertText }], () => []);
            if (cursor >= 0) {
              const focusEditor = editor.getEditors().find((e) => e.hasTextFocus());
              focusEditor.setPosition(position.delta(0, cursor));
            }
          }
        }
      }),
    );
  };
  editor.onDidCreateModel(validateModel);
  editor.onDidChangeModelLanguage(({ model, oldLanguage }) => {
    const modelUri = model.uri.toString();
    if (oldLanguage === langaugeId && listeners.has(modelUri)) {
      listeners.get(modelUri).dispose();
      listeners.delete(modelUri);
    }
    validateModel(model);
  });
  editor.onWillDisposeModel((model) => {
    const modelUri = model.uri.toString();
    if (model.getLanguageId() === langaugeId && listeners.has(modelUri)) {
      listeners.get(modelUri).dispose();
      listeners.delete(modelUri);
    }
  });
  editor.getModels().forEach(validateModel);
}

// #endregion

// #region DocumentSymbolAdapter

export interface ILanguageWorkerWithDocumentSymbols {
  findDocumentSymbols(uri: string): Promise<(lst.SymbolInformation | lst.DocumentSymbol)[] | null>;
}

export class DocumentSymbolAdapter<T extends ILanguageWorkerWithDocumentSymbols> implements Monaco.languages.DocumentSymbolProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideDocumentSymbols(
    model: Monaco.editor.IReadOnlyModel,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.DocumentSymbol[] | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const items = await lspRequest(() => worker?.findDocumentSymbols(model.uri.toString()), token);
    if (items) {
      return items.map((item) => {
        if (isDocumentSymbol(item)) {
          return convertDocumentSymbol(item);
        }
        return {
          name: item.name,
          detail: "",
          containerName: item.containerName,
          kind: convertSymbolKind(item.kind),
          range: convertRange(item.location.range),
          selectionRange: convertRange(item.location.range),
          tags: item.tags ?? [],
        };
      });
    }
  }
}

function isDocumentSymbol(symbol: lst.SymbolInformation | lst.DocumentSymbol): symbol is lst.DocumentSymbol {
  return "children" in symbol;
}

function convertDocumentSymbol(symbol: lst.DocumentSymbol): Monaco.languages.DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: convertSymbolKind(symbol.kind),
    range: convertRange(symbol.range),
    selectionRange: convertRange(symbol.selectionRange),
    tags: symbol.tags ?? [],
    children: (symbol.children ?? []).map((item) => convertDocumentSymbol(item)),
    containerName: Reflect.get(symbol, "containerName"),
  };
}

function convertSymbolKind(kind: lst.SymbolKind): Monaco.languages.SymbolKind {
  const mKind = monaco.languages.SymbolKind;
  switch (kind) {
    case lst.SymbolKind.File:
      return mKind.File;
    case lst.SymbolKind.Module:
      return mKind.Module;
    case lst.SymbolKind.Namespace:
      return mKind.Namespace;
    case lst.SymbolKind.Package:
      return mKind.Package;
    case lst.SymbolKind.Class:
      return mKind.Class;
    case lst.SymbolKind.Method:
      return mKind.Method;
    case lst.SymbolKind.Property:
      return mKind.Property;
    case lst.SymbolKind.Field:
      return mKind.Field;
    case lst.SymbolKind.Constructor:
      return mKind.Constructor;
    case lst.SymbolKind.Enum:
      return mKind.Enum;
    case lst.SymbolKind.Interface:
      return mKind.Interface;
    case lst.SymbolKind.Function:
      return mKind.Function;
    case lst.SymbolKind.Variable:
      return mKind.Variable;
    case lst.SymbolKind.Constant:
      return mKind.Constant;
    case lst.SymbolKind.String:
      return mKind.String;
    case lst.SymbolKind.Number:
      return mKind.Number;
    case lst.SymbolKind.Boolean:
      return mKind.Boolean;
    case lst.SymbolKind.Array:
      return mKind.Array;
  }
  return mKind.Function;
}

// #endregion

// #region DefinitionAdapter

export interface ILanguageWorkerWithDefinitions {
  findDefinition(
    uri: string,
    position: lst.Position,
  ): Promise<(lst.Location | lst.LocationLink)[] | null>;
}

export class DefinitionAdapter<T extends ILanguageWorkerWithDefinitions> implements Monaco.languages.DefinitionProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideDefinition(
    model: Monaco.editor.IReadOnlyModel,
    position: Monaco.Position,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.Definition | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const definition = await lspRequest(() => worker?.findDefinition(model.uri.toString(), fromPosition(position)), token);
    if (definition) {
      const links = (Array.isArray(definition) ? definition : [definition]).map(convertLocationLink);
      await ensureHttpModels(links);
      return links;
    }
  }
}

function isLocationLink(location: lst.Location | lst.LocationLink): location is lst.LocationLink {
  return "targetUri" in location;
}

function convertLocationLink(location: lst.Location | lst.LocationLink): Monaco.languages.LocationLink {
  let uri: string;
  let range: lst.Range;
  let originSelectionRange: lst.Range | undefined;
  let targetSelectionRange: lst.Range | undefined;
  if (isLocationLink(location)) {
    uri = location.targetUri;
    range = location.targetRange;
    originSelectionRange = location.originSelectionRange;
    targetSelectionRange = location.targetSelectionRange;
  } else {
    uri = location.uri;
    range = location.range;
  }
  if (uri.includes(".(embedded).")) {
    uri = uri.slice(0, uri.lastIndexOf(".(embedded)."));
  }
  return {
    uri: monaco.Uri.parse(uri),
    range: convertRange(range),
    originSelectionRange: originSelectionRange ? convertRange(originSelectionRange) : undefined,
    targetSelectionRange: targetSelectionRange ? convertRange(targetSelectionRange) : undefined,
  };
}

async function ensureHttpModels(links: Monaco.languages.LocationLink[]): Promise<void> {
  const { editor, Uri } = monaco;
  const httpUrls = new Set<string>(
    links
      .map(link => link.uri)
      .filter(uri => !editor.getModel(uri) && (uri.scheme === "https" || uri.scheme === "http"))
      .map(uri => uri.toString()),
  );
  await Promise.all(
    [...httpUrls].map(async url => {
      const text = await cache.fetch(url).then(res => res.text());
      const uri = Uri.parse(url);
      if (!editor.getModel(uri)) {
        editor.createModel(text, undefined, uri);
      }
    }),
  );
}

// #endregion

// #region ReferenceAdapter

export interface ILanguageWorkerWithReferences {
  findReferences(uri: string, position: lst.Position): Promise<lst.Location[] | null>;
}

export class ReferenceAdapter<T extends ILanguageWorkerWithReferences> implements Monaco.languages.ReferenceProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideReferences(
    model: Monaco.editor.IReadOnlyModel,
    position: Monaco.Position,
    context: Monaco.languages.ReferenceContext,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.Location[] | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const references = await lspRequest(() => worker?.findReferences(model.uri.toString(), fromPosition(position)), token);
    if (references) {
      const links = references.map(convertLocationLink);
      await ensureHttpModels(links);
      return links;
    }
  }
}

// #endregion

// #region DocumentLinkAdapter

export interface ILanguageWorkerWithDocumentLinks {
  findDocumentLinks(uri: string): Promise<lst.DocumentLink[] | null>;
}

export function enableDocumentLinks<T extends ILanguageWorkerWithDocumentLinks>(
  langaugeId: string,
  worker: Monaco.editor.MonacoWebWorker<T>,
) {
  monaco.languages.registerLinkProvider(langaugeId, new DocumentLinkAdapter(worker));
}

export class DocumentLinkAdapter<T extends ILanguageWorkerWithDocumentLinks> implements Monaco.languages.LinkProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideLinks(
    model: Monaco.editor.IReadOnlyModel,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.ILinksList | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const items = await lspRequest(() => worker?.findDocumentLinks(model.uri.toString()), token);
    if (items) {
      const links = items.map((item) => ({
        range: convertRange(item.range),
        url: item.target,
      }));
      return { links };
    }
  }
}

// #endregion

// #region DocumentColorAdapter

export interface ILanguageWorkerWithDocumentColors {
  findDocumentColors(uri: string): Promise<lst.ColorInformation[] | null>;
  getColorPresentations(uri: string, color: lst.Color, range: lst.Range): Promise<lst.ColorPresentation[] | null>;
}

export function enableColorPresentation<T extends ILanguageWorkerWithDocumentColors>(
  langaugeId: string,
  worker: Monaco.editor.MonacoWebWorker<T>,
) {
  monaco.languages.registerColorProvider(langaugeId, new DocumentColorAdapter(worker));
}

export class DocumentColorAdapter<T extends ILanguageWorkerWithDocumentColors> implements Monaco.languages.DocumentColorProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideDocumentColors(
    model: Monaco.editor.IReadOnlyModel,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.IColorInformation[] | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const colors = await lspRequest(() => worker?.findDocumentColors(model.uri.toString()), token);
    if (colors) {
      return colors.map((item) => ({
        color: item.color,
        range: convertRange(item.range),
      }));
    }
  }

  async provideColorPresentations(
    model: Monaco.editor.IReadOnlyModel,
    info: Monaco.languages.IColorInformation,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.IColorPresentation[] | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const presentations = await lspRequest(
      () => worker.getColorPresentations(model.uri.toString(), info.color, fromRange(info.range)),
      token,
    );
    if (presentations) {
      return presentations.map((presentation) => ({
        label: presentation.label,
        textEdit: convertTextEdit(presentation.textEdit),
        additionalTextEdits: presentation.additionalTextEdits?.map(convertTextEdit),
      }));
    }
  }
}

// #endregion

// #region DocumentHighlightAdapter

export interface ILanguageWorkerWithDocumentHighlights {
  findDocumentHighlights(uri: string, position: lst.Position): Promise<lst.DocumentHighlight[] | null>;
}

export class DocumentHighlightAdapter<
  T extends ILanguageWorkerWithDocumentHighlights,
> implements Monaco.languages.DocumentHighlightProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideDocumentHighlights(
    model: Monaco.editor.IReadOnlyModel,
    position: Monaco.Position,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.DocumentHighlight[] | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const entries = await lspRequest(() => worker?.findDocumentHighlights(model.uri.toString(), fromPosition(position)), token);
    if (entries) {
      return entries.map((entry) => {
        return <Monaco.languages.DocumentHighlight> {
          range: convertRange(entry.range),
          kind: convertDocumentHighlightKind(entry.kind),
        };
      });
    }
  }
}

function convertDocumentHighlightKind(kind: lst.DocumentHighlightKind | undefined): Monaco.languages.DocumentHighlightKind {
  switch (kind) {
    case lst.DocumentHighlightKind.Read:
      return monaco.languages.DocumentHighlightKind.Read;
    case lst.DocumentHighlightKind.Write:
      return monaco.languages.DocumentHighlightKind.Write;
    case lst.DocumentHighlightKind.Text:
      return monaco.languages.DocumentHighlightKind.Text;
  }
  return monaco.languages.DocumentHighlightKind.Text;
}

// #endregion

// #region FoldingRangeAdapter

export interface ILanguageWorkerWithFoldingRanges {
  getFoldingRanges(uri: string, context?: { rangeLimit?: number }): Promise<lst.FoldingRange[] | null>;
}

export class FoldingRangeAdapter<T extends ILanguageWorkerWithFoldingRanges> implements Monaco.languages.FoldingRangeProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideFoldingRanges(
    model: Monaco.editor.IReadOnlyModel,
    context: Monaco.languages.FoldingContext,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.FoldingRange[] | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const ranges = await lspRequest(() => worker?.getFoldingRanges(model.uri.toString(), context), token);
    if (ranges) {
      return ranges.map((range) => {
        const result: Monaco.languages.FoldingRange = {
          start: range.startLine + 1,
          end: range.endLine + 1,
        };
        if (typeof range.kind !== "undefined") {
          result.kind = convertFoldingRangeKind(range.kind);
        }
        return result;
      });
    }
  }
}

function convertFoldingRangeKind(kind: lst.FoldingRangeKind): Monaco.languages.FoldingRangeKind | undefined {
  switch (kind) {
    case lst.FoldingRangeKind.Comment:
      return monaco.languages.FoldingRangeKind.Comment;
    case lst.FoldingRangeKind.Imports:
      return monaco.languages.FoldingRangeKind.Imports;
    case lst.FoldingRangeKind.Region:
      return monaco.languages.FoldingRangeKind.Region;
  }
  return undefined;
}

// #endregion

// #region SelectionRangeAdapter

export interface ILanguageWorkerWithSelectionRanges {
  getSelectionRanges(uri: string, positions: lst.Position[]): Promise<lst.SelectionRange[] | null>;
}

export class SelectionRangeAdapter<T extends ILanguageWorkerWithSelectionRanges> implements Monaco.languages.SelectionRangeProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideSelectionRanges(
    model: Monaco.editor.IReadOnlyModel,
    positions: Monaco.Position[],
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.SelectionRange[][] | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const selectionRanges = await lspRequest(() => worker?.getSelectionRanges(model.uri.toString(), positions.map(fromPosition)), token);
    if (selectionRanges) {
      return selectionRanges.map(
        (selectionRange: lst.SelectionRange | undefined) => {
          const result: Monaco.languages.SelectionRange[] = [];
          while (selectionRange) {
            result.push({ range: convertRange(selectionRange.range) });
            selectionRange = selectionRange.parent;
          }
          return result;
        },
      );
    }
  }
}

// #endregion

// #region LinkedEditingRangeAdapter

export interface ILanguageWorkerWithLinkedEditingRange {
  getLinkedEditingRangeAtPosition(
    uri: string,
    position: lst.Position,
  ): Promise<{ ranges: lst.Range[]; wordPattern?: string } | null>;
}

export class LinkedEditingRangeAdapter<T extends ILanguageWorkerWithLinkedEditingRange>
  implements Monaco.languages.LinkedEditingRangeProvider
{
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  async provideLinkedEditingRanges(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.LinkedEditingRanges | undefined> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const editingRange = await lspRequest(
      () => worker.getLinkedEditingRangeAtPosition(model.uri.toString(), fromPosition(position)),
      token,
    );
    if (editingRange) {
      const { wordPattern, ranges } = editingRange;
      return {
        ranges: ranges.map((range) => convertRange(range)),
        wordPattern: wordPattern ? new RegExp(wordPattern) : undefined,
      };
    }
  }
}

// #endregion

// #region InlayHintsAdapter

export interface ILanguageWorkerWithInlayHints {
  provideInlayHints(uri: string, range: lst.Range): Promise<lst.InlayHint[] | null>;
}

export class InlayHintsAdapter<T extends ILanguageWorkerWithInlayHints> implements Monaco.languages.InlayHintsProvider {
  constructor(
    private readonly _worker: Monaco.editor.MonacoWebWorker<T>,
  ) {}

  public async provideInlayHints(
    model: Monaco.editor.ITextModel,
    range: Monaco.Range,
    token: Monaco.CancellationToken,
  ): Promise<Monaco.languages.InlayHintList> {
    const worker = await lspRequest(() => this._worker.withSyncedResources([model.uri]), token);
    const hints = await lspRequest(() => worker?.provideInlayHints(model.uri.toString(), fromRange(range)), token);
    return { hints: hints?.map(convertInlayHint) ?? [], dispose: () => {} };
  }
}

function convertInlayHint(hint: lst.InlayHint): Monaco.languages.InlayHint {
  return {
    label: convertLabelText(hint.label),
    tooltip: hint.tooltip,
    textEdits: hint.textEdits?.map(convertTextEdit),
    position: convertPosition(hint.position),
    kind: hint.kind,
    paddingLeft: hint.paddingLeft,
    paddingRight: hint.paddingRight,
  };
}

function convertLabelText(label: lst.InlayHintLabelPart[] | string): string | Monaco.languages.InlayHintLabelPart[] {
  if (typeof label === "string") {
    return label;
  }
  return label.map(convertInlayHintLabelPart);
}

function convertInlayHintLabelPart(part: lst.InlayHintLabelPart): Monaco.languages.InlayHintLabelPart {
  return {
    label: part.value,
    tooltip: part.tooltip,
    command: convertCommand(part.command),
    location: convertLocationLink(part.location),
  };
}

function convertPosition(position: lst.Position): Monaco.Position {
  return new monaco.Position(position.line + 1, position.character + 1);
}

// #endregion
