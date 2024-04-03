/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) X. <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type monacoNS from "monaco-editor-core";
import * as lst from "vscode-languageserver-types";
import { cache } from "../cache.js";

let Monaco: typeof monacoNS;

export interface WorkerProxy<T> {
  (...more: monacoNS.Uri[]): Promise<T>;
}

export function setup(monaco: typeof monacoNS) {
  Monaco = monaco;
}

// #region register default language features

const refreshEmitters: Map<string, monacoNS.Emitter<void>> = new Map();

export function registerDefault<
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
    & { onDocumentRemoved(uri: string): void },
>(
  languageId: string,
  workerProxy: WorkerProxy<T>,
  completionTriggerCharacters: string[],
) {
  const { editor, languages, Emitter } = Monaco;

  // remove document cache from worker when the model is disposed
  const onDispose = (model: monacoNS.editor.ITextModel) => workerProxy().then((worker) => worker.onDocumentRemoved(model.uri.toString()));
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
  enableDiagnostics(languageId, workerProxy);

  // register language features
  languages.registerCompletionItemProvider(languageId, new CompletionAdapter(workerProxy, completionTriggerCharacters));
  languages.registerHoverProvider(languageId, new HoverAdapter(workerProxy));
  languages.registerDocumentSymbolProvider(languageId, new DocumentSymbolAdapter(workerProxy));
  languages.registerDefinitionProvider(languageId, new DefinitionAdapter(workerProxy));
  languages.registerReferenceProvider(languageId, new ReferenceAdapter(workerProxy));
  languages.registerRenameProvider(languageId, new RenameAdapter(workerProxy));
  languages.registerDocumentFormattingEditProvider(languageId, new DocumentFormattingEditProvider(workerProxy));
  languages.registerDocumentRangeFormattingEditProvider(languageId, new DocumentRangeFormattingEditProvider(workerProxy));
  languages.registerFoldingRangeProvider(languageId, new FoldingRangeAdapter(workerProxy));
  languages.registerDocumentHighlightProvider(languageId, new DocumentHighlightAdapter(workerProxy));
  languages.registerSelectionRangeProvider(languageId, new SelectionRangeAdapter(workerProxy));
}

export function refreshDiagnostics(...langaugeIds: string[]) {
  langaugeIds.forEach((langaugeId) => {
    refreshEmitters.get(langaugeId)?.fire();
  });
}

// #endregion

// #region EmbeddedLanguages

export interface ILanguageWorkerWithEmbeddedSupport {
  getEmbeddedDocument(uri: string, langaugeId: string): Promise<{ content: string } | null>;
}

export function attachEmbeddedLanguages<T extends ILanguageWorkerWithEmbeddedSupport>(
  languageId: string,
  embeddedLanguages: Record<string, string>,
  workerProxy: WorkerProxy<T>,
) {
  const { editor, Uri } = Monaco;
  const embeddedLanguageIds = Object.keys(embeddedLanguages);
  const listeners = new Map<string, monacoNS.IDisposable>();
  const toEmbeddedUri = (uri: monacoNS.Uri, rsl: string) => {
    return Uri.parse(uri.path + ".__EMBEDDED__." + embeddedLanguages[rsl]);
  };
  const validateModel = async (model: monacoNS.editor.IModel) => {
    if (model.getLanguageId() !== languageId) {
      return;
    }
    const modelUri = model.uri.toString();
    const getEmbeddedDocument = (rsl: string) => workerProxy(model.uri).then((worker) => worker.getEmbeddedDocument(modelUri, rsl));
    const attachEmbeddedLanguage = async (rsl: string) => {
      const uri = toEmbeddedUri(model.uri, rsl);
      const doc = await getEmbeddedDocument(rsl);
      if (doc) {
        let embeddedModel = editor.getModel(uri);
        if (!embeddedModel) {
          embeddedModel = editor.createModel(doc.content, rsl === "importmap" ? "json" : rsl, uri);
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
    const attachAll = () => embeddedLanguageIds.forEach(attachEmbeddedLanguage);
    listeners.set(modelUri, model.onDidChangeContent(attachAll));
    attachAll();
  };
  const cleanUp = (model: monacoNS.editor.IModel) => {
    const uri = model.uri.toString();
    if (listeners.has(uri)) {
      listeners.get(uri).dispose();
      listeners.delete(uri);
    }
    embeddedLanguageIds.forEach((rsl) => {
      const uri = toEmbeddedUri(model.uri, rsl);
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
}

export function proxyWorkerWithEmbeddedLanguages<T extends ILanguageWorkerWithEmbeddedSupport>(
  embeddedLanguages: Record<string, string>,
  rawWorkerProxy: WorkerProxy<T>,
): WorkerProxy<T> {
  const redirectLSPRequest = async (rsl: string, method: string, uri: string, ...args: any[]) => {
    // @ts-expect-error `workerProxies` is added by esm-monaco
    const { workerProxies } = MonacoEnvironment;
    const langaugeId = rsl === "importmap" ? "json" : rsl;
    const workerProxy = workerProxies[langaugeId];
    if (typeof workerProxy === "function") {
      const embeddedUri = Monaco.Uri.parse(uri + ".__EMBEDDED__." + embeddedLanguages[rsl]);
      return workerProxy(embeddedUri).then(worker => worker[method]?.(embeddedUri.toString(), ...args));
    }
    if (!workerProxy) {
      workerProxies[langaugeId] = {
        resolve: () => {
          // refresh diagnostics
          refreshDiagnostics(langaugeId);
        },
      };
    }
    return null;
  };

  return async (...uris) => {
    const worker = await rawWorkerProxy(...uris);
    return new Proxy(worker, {
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
  };
}

// #endregion

// #region Diagnostics

export interface ILanguageWorkerWithValidation {
  doValidation(uri: string): Promise<lst.Diagnostic[] | null>;
}

function enableDiagnostics<T extends ILanguageWorkerWithValidation>(
  languageId: string,
  workerProxy: WorkerProxy<T>,
) {
  const { editor, Emitter } = Monaco;
  const refreshEmitter = new Emitter<void>();
  const listeners = new Map<string, monacoNS.IDisposable>();
  const doValidate = async (model: monacoNS.editor.ITextModel) => {
    const worker = await workerProxy(model.uri);
    const diagnostics = await worker.doValidation(model.uri.toString());
    if (diagnostics && !model.isDisposed()) {
      const markers = diagnostics.map(toMarker);
      Monaco.editor.setModelMarkers(model, languageId, markers);
    }
  };
  const validateModel = (model: monacoNS.editor.IModel): void => {
    const modelId = model.getLanguageId();
    const uri = model.uri.toString();
    if (modelId !== languageId || uri.includes(".__EMBEDDED__.")) {
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
  const dispose = (model: monacoNS.editor.IModel): void => {
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

function toMarker({
  range,
  severity,
  code,
  message,
  source,
  tags,
  relatedInformation,
}: lst.Diagnostic): monacoNS.editor.IMarkerData {
  const { start, end } = range;
  return {
    startLineNumber: start.line + 1,
    startColumn: start.character + 1,
    endLineNumber: end.line + 1,
    endColumn: end.character + 1,
    severity: toSeverity(severity),
    code: typeof code === "number" ? String(code) : code,
    message,
    source,
    tags,
    relatedInformation: relatedInformation?.map(toRelatedInformation),
  };
}

function toSeverity(lsSeverity: number | undefined): monacoNS.MarkerSeverity {
  switch (lsSeverity) {
    case lst.DiagnosticSeverity.Error:
      return Monaco.MarkerSeverity.Error;
    case lst.DiagnosticSeverity.Warning:
      return Monaco.MarkerSeverity.Warning;
    case lst.DiagnosticSeverity.Information:
      return Monaco.MarkerSeverity.Info;
    case lst.DiagnosticSeverity.Hint:
      return Monaco.MarkerSeverity.Hint;
    default:
      return Monaco.MarkerSeverity.Info;
  }
}

function toRelatedInformation(info: lst.DiagnosticRelatedInformation): monacoNS.editor.IRelatedInformation {
  const { location: { uri, range }, message } = info;
  const { start, end } = range;
  return {
    resource: Monaco.Uri.parse(uri),
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

export class CompletionAdapter<T extends ILanguageWorkerWithCompletions> implements monacoNS.languages.CompletionItemProvider {
  constructor(
    private readonly _worker: WorkerProxy<T>,
    private readonly _triggerCharacters: string[],
  ) {}

  get triggerCharacters(): string[] {
    return this._triggerCharacters;
  }

  async provideCompletionItems(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
    context: monacoNS.languages.CompletionContext, // todo: use context
  ): Promise<monacoNS.languages.CompletionList | undefined> {
    const worker = await this._worker(model.uri);
    const info = await worker.doComplete(model.uri.toString(), fromPosition(position));
    if (!info) {
      return;
    }

    const wordInfo = model.getWordUntilPosition(position);
    const wordRange = new Monaco.Range(
      position.lineNumber,
      wordInfo.startColumn,
      position.lineNumber,
      wordInfo.endColumn,
    );
    const items: monacoNS.languages.CompletionItem[] = info.items.map((entry) => {
      const item: monacoNS.languages.CompletionItem & { data?: any } = {
        command: entry.command && toCommand(entry.command),
        data: entry.data,
        detail: entry.detail,
        documentation: entry.documentation,
        filterText: entry.filterText,
        insertText: entry.insertText || entry.label,
        kind: toCompletionItemKind(entry.kind),
        label: entry.label,
        range: wordRange,
        sortText: entry.sortText,
        tags: entry.tags,
      };
      if (entry.textEdit) {
        if (isInsertReplaceEdit(entry.textEdit)) {
          item.range = {
            insert: toRange(entry.textEdit.insert),
            replace: toRange(entry.textEdit.replace),
          };
        } else {
          item.range = toRange(entry.textEdit.range);
        }
        item.insertText = entry.textEdit.newText;
      }
      if (entry.additionalTextEdits) {
        item.additionalTextEdits = entry.additionalTextEdits.map<monacoNS.languages.TextEdit>(toTextEdit);
      }
      if (entry.insertTextFormat === lst.InsertTextFormat.Snippet) {
        item.insertTextRules = Monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
      }
      return item;
    });

    return {
      suggestions: items,
      incomplete: info.isIncomplete,
    };
  }

  async resolveCompletionItem(
    item: monacoNS.languages.CompletionItem & { data?: any },
  ): Promise<monacoNS.languages.CompletionItem> {
    if (item.data?.context) {
      // @ts-expect-error `workerProxies` is added by esm-monaco
      const { workerProxies } = MonacoEnvironment;
      const { languageId } = item.data.context;
      const workerProxy = workerProxies[languageId];
      if (typeof workerProxy === "function") {
        const worker: ILanguageWorkerWithCompletions = await workerProxy();
        const details = await worker.doResolveCompletionItem?.(item as unknown as lst.CompletionItem);
        if (details) {
          item.detail = details.detail;
          item.documentation = details.documentation;
          item.additionalTextEdits = details.additionalTextEdits?.map(toTextEdit);
        }
      }
    } else {
      const worker = await this._worker();
      const details = await worker.doResolveCompletionItem?.(item as unknown as lst.CompletionItem);
      if (details) {
        item.detail = details.detail;
        item.documentation = details.documentation;
        item.additionalTextEdits = details.additionalTextEdits?.map(toTextEdit);
      }
    }
    return item;
  }
}

export function fromPosition(position: monacoNS.Position): lst.Position;
export function fromPosition(position: undefined): undefined;
export function fromPosition(position: monacoNS.Position | undefined): lst.Position | undefined;
export function fromPosition(position: monacoNS.Position | undefined): lst.Position | undefined {
  if (!position) {
    return undefined;
  }
  return { character: position.column - 1, line: position.lineNumber - 1 };
}

export function fromRange(range: monacoNS.IRange): lst.Range;
export function fromRange(range: undefined): undefined;
export function fromRange(range: monacoNS.IRange | undefined): lst.Range | undefined;
export function fromRange(range: monacoNS.IRange | undefined): lst.Range | undefined {
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

export function toRange(range: lst.Range): monacoNS.Range;
export function toRange(range: undefined): undefined;
export function toRange(range: lst.Range | undefined): monacoNS.Range | undefined;
export function toRange(range: lst.Range | undefined): monacoNS.Range | undefined {
  if (!range) {
    return undefined;
  }
  return new Monaco.Range(
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

function toCompletionItemKind(
  kind: number | undefined,
): monacoNS.languages.CompletionItemKind {
  const mItemKind = Monaco.languages.CompletionItemKind;

  switch (kind) {
    case lst.CompletionItemKind.Text:
      return mItemKind.Text;
    case lst.CompletionItemKind.Method:
      return mItemKind.Method;
    case lst.CompletionItemKind.Function:
      return mItemKind.Function;
    case lst.CompletionItemKind.Constructor:
      return mItemKind.Constructor;
    case lst.CompletionItemKind.Field:
      return mItemKind.Field;
    case lst.CompletionItemKind.Variable:
      return mItemKind.Variable;
    case lst.CompletionItemKind.Class:
      return mItemKind.Class;
    case lst.CompletionItemKind.Interface:
      return mItemKind.Interface;
    case lst.CompletionItemKind.Module:
      return mItemKind.Module;
    case lst.CompletionItemKind.Property:
      return mItemKind.Property;
    case lst.CompletionItemKind.Unit:
      return mItemKind.Unit;
    case lst.CompletionItemKind.Value:
      return mItemKind.Value;
    case lst.CompletionItemKind.Enum:
      return mItemKind.Enum;
    case lst.CompletionItemKind.Keyword:
      return mItemKind.Keyword;
    case lst.CompletionItemKind.Snippet:
      return mItemKind.Snippet;
    case lst.CompletionItemKind.Color:
      return mItemKind.Color;
    case lst.CompletionItemKind.File:
      return mItemKind.File;
    case lst.CompletionItemKind.Reference:
      return mItemKind.Reference;
  }
  return mItemKind.Property;
}

export function toTextEdit(textEdit: lst.TextEdit): monacoNS.languages.TextEdit;
export function toTextEdit(textEdit: undefined): undefined;
export function toTextEdit(textEdit: lst.TextEdit | undefined): monacoNS.languages.TextEdit | undefined;
export function toTextEdit(textEdit: lst.TextEdit | undefined): monacoNS.languages.TextEdit | undefined {
  if (!textEdit) {
    return undefined;
  }
  return {
    range: toRange(textEdit.range),
    text: textEdit.newText,
  };
}

function toCommand(c: lst.Command | undefined): monacoNS.languages.Command | undefined {
  return c ? { id: c.command ?? Reflect.get(c, "id"), title: c.title, arguments: c.arguments } : undefined;
}

// #endregion

// #region HoverAdapter

export interface ILanguageWorkerWithHover {
  doHover(uri: string, position: lst.Position): Promise<lst.Hover | null>;
}

export class HoverAdapter<T extends ILanguageWorkerWithHover> implements monacoNS.languages.HoverProvider {
  constructor(private readonly _worker: WorkerProxy<T>) {}

  async provideHover(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
  ): Promise<monacoNS.languages.Hover | undefined> {
    const worker = await this._worker(model.uri);
    const info = await worker.doHover(model.uri.toString(), fromPosition(position));
    if (info) {
      return {
        range: toRange(info.range),
        contents: toMarkedStringArray(info.contents),
      };
    }
  }
}

function isMarkupContent(v: any): v is lst.MarkupContent {
  return (v && typeof v === "object" && typeof (<lst.MarkupContent> v).kind === "string");
}

function toMarkdownString(entry: lst.MarkupContent | lst.MarkedString): monacoNS.IMarkdownString {
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

function toMarkedStringArray(
  contents: lst.MarkupContent | lst.MarkedString | lst.MarkedString[],
): monacoNS.IMarkdownString[] | undefined {
  if (!contents) {
    return undefined;
  }
  if (Array.isArray(contents)) {
    return contents.map(toMarkdownString);
  }
  return [toMarkdownString(contents)];
}

// #endregion

// #region SignatureHelpAdapter

interface ILanguageWorkerWithSignatureHelp {
  doSignatureHelp(
    uri: string,
    position: number,
    context: monacoNS.languages.SignatureHelpContext,
  ): Promise<lst.SignatureHelp | null>;
}

export class SignatureHelpAdapter<T extends ILanguageWorkerWithSignatureHelp> implements monacoNS.languages.SignatureHelpProvider {
  constructor(
    private readonly _worker: WorkerProxy<T>,
    private readonly _triggerCharacters: string[],
  ) {}

  get signatureHelpTriggerCharacters() {
    return this._triggerCharacters;
  }

  async provideSignatureHelp(
    model: monacoNS.editor.ITextModel,
    position: monacoNS.Position,
    _token: monacoNS.CancellationToken,
    context: monacoNS.languages.SignatureHelpContext,
  ): Promise<monacoNS.languages.SignatureHelpResult | undefined> {
    const resource = model.uri;
    const offset = model.getOffsetAt(position);
    const worker = await this._worker(resource);
    const helpInfo = await worker.doSignatureHelp(resource.toString(), offset, context);
    if (!helpInfo || model.isDisposed()) {
      return undefined;
    }
    helpInfo.signatures?.forEach(s => {
      if (typeof s.documentation === "string") {
        s.documentation = { kind: "markdown", value: s.documentation };
      }
    });
    return {
      value: <monacoNS.languages.SignatureHelp> helpInfo,
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

export class CodeActionAdaptor<T extends ILanguageWorkerWithCodeAction> implements monacoNS.languages.CodeActionProvider {
  constructor(private readonly _worker: WorkerProxy<T>) {}

  public async provideCodeActions(
    model: monacoNS.editor.ITextModel,
    range: monacoNS.Range,
    context: monacoNS.languages.CodeActionContext,
  ): Promise<monacoNS.languages.CodeActionList | undefined> {
    const modelOptions = model.getOptions();
    const formatOptions: lst.FormattingOptions = {
      tabSize: modelOptions.tabSize,
      insertSpaces: modelOptions.insertSpaces,
    };
    const worker = await this._worker(model.uri);
    const codeActions = await worker.doCodeAction(model.uri.toString(), fromRange(range), toCodeActionContext(context), formatOptions);
    if (codeActions) {
      return {
        actions: codeActions.map(action => ({
          kind: action.kind ?? "quickfix",
          title: action.title,
          edit: action.edit && toWorkspaceEdit(action.edit),
          diagnostics: context.markers,
          command: action.command && toCommand(action.command),
        })),
        dispose: () => {},
      };
    }
  }
}

function toCodeActionContext(context: monacoNS.languages.CodeActionContext): lst.CodeActionContext {
  return {
    diagnostics: context.markers.map(toLstDiagnostic),
    only: [context.only],
    triggerKind: context.trigger,
  };
}

function toLstDiagnostic(marker: monacoNS.editor.IMarkerData): lst.Diagnostic {
  return {
    code: typeof marker.code === "string" ? marker.code : marker.code?.value,
    message: marker.message,
    range: fromRange(marker),
    severity: toLstDiagnosticSeverity(marker.severity),
    source: marker.source,
    tags: marker.tags,
  };
}

function toLstDiagnosticSeverity(severity: monacoNS.MarkerSeverity): lst.DiagnosticSeverity {
  switch (severity) {
    case Monaco.MarkerSeverity.Error:
      return lst.DiagnosticSeverity.Error;
    case Monaco.MarkerSeverity.Warning:
      return lst.DiagnosticSeverity.Warning;
    case Monaco.MarkerSeverity.Hint:
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

export class RenameAdapter<T extends ILanguageWorkerWithRename> implements monacoNS.languages.RenameProvider {
  constructor(private readonly _worker: WorkerProxy<T>) {}

  async provideRenameEdits(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
    newName: string,
  ): Promise<monacoNS.languages.WorkspaceEdit | undefined> {
    const worker = await this._worker(model.uri);
    const edit = await worker.doRename(model.uri.toString(), fromPosition(position), newName);
    if (edit) {
      return toWorkspaceEdit(edit);
    }
  }
}

function toWorkspaceEdit(edit: lst.WorkspaceEdit): monacoNS.languages.WorkspaceEdit | undefined {
  if (!edit.changes) {
    return undefined;
  }
  let resourceEdits: monacoNS.languages.IWorkspaceTextEdit[] = [];
  for (let uri in edit.changes) {
    const _uri = Monaco.Uri.parse(uri);
    for (let e of edit.changes[uri]) {
      resourceEdits.push({
        resource: _uri,
        versionId: undefined,
        textEdit: {
          range: toRange(e.range),
          text: e.newText,
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
  implements monacoNS.languages.DocumentFormattingEditProvider
{
  constructor(private _worker: WorkerProxy<T>) {}

  async provideDocumentFormattingEdits(
    model: monacoNS.editor.IReadOnlyModel,
    options: monacoNS.languages.FormattingOptions,
  ): Promise<monacoNS.languages.TextEdit[] | undefined> {
    const worker = await this._worker(model.uri);
    const edits = await worker.doFormat(model.uri.toString(), null, options as lst.FormattingOptions);
    if (edits) {
      return edits.map<monacoNS.languages.TextEdit>(toTextEdit);
    }
  }
}

export class DocumentRangeFormattingEditProvider<T extends ILanguageWorkerWithFormat>
  implements monacoNS.languages.DocumentRangeFormattingEditProvider
{
  constructor(private _worker: WorkerProxy<T>) {}

  async provideDocumentRangeFormattingEdits(
    model: monacoNS.editor.IReadOnlyModel,
    range: monacoNS.Range,
    options: monacoNS.languages.FormattingOptions,
  ): Promise<monacoNS.languages.TextEdit[] | undefined> {
    const worker = await this._worker(model.uri);
    const edits = await worker.doFormat(model.uri.toString(), fromRange(range), options as lst.FormattingOptions);
    if (edits) {
      return edits.map<monacoNS.languages.TextEdit>(toTextEdit);
    }
  }
}

// #endregion

// #region AutoInsert

export interface ILanguageWorkerWithAutoInsert {
  doAutoInsert(uri: string, position: lst.Position, ch: string): Promise<string | null>;
}

export function enableAutoInsert<T extends ILanguageWorkerWithAutoInsert>(
  langaugeId: string,
  workerProxy: WorkerProxy<T>,
  triggerCharacters: string[],
) {
  const { editor } = Monaco;
  const listeners = new Map<string, monacoNS.IDisposable>();
  const validateModel = async (model: monacoNS.editor.IModel) => {
    if (model.getLanguageId() !== langaugeId) {
      return;
    }
    const modelUri = model.uri.toString();
    listeners.set(
      modelUri,
      model.onDidChangeContent(async (e: monacoNS.editor.IModelContentChangedEvent) => {
        const lastChange = e.changes[e.changes.length - 1];
        const lastCharacter = lastChange.text[lastChange.text.length - 1];
        if (triggerCharacters.includes(lastCharacter)) {
          const lastRange = lastChange.range;
          const position = new Monaco.Position(lastRange.endLineNumber, lastRange.endColumn + lastChange.text.length);
          const worker = await workerProxy(model.uri);
          const snippet = await worker.doAutoInsert(modelUri, fromPosition(position), lastCharacter);
          if (snippet) {
            const cursor = snippet.indexOf("$0");
            const insertText = cursor >= 0 ? snippet.replace("$0", "") : snippet;
            const range = new Monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
            model.pushEditOperations([], [{ range, text: insertText }], () => []);
            if (cursor >= 0) {
              const activeEditor = editor.getEditors().find((e) => e.getModel() === model);
              activeEditor.setPosition(position.delta(0, cursor));
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

// #region DocumentSymbolAdapter

export interface ILanguageWorkerWithDocumentSymbols {
  findDocumentSymbols(uri: string): Promise<(lst.SymbolInformation | lst.DocumentSymbol)[] | null>;
}

export class DocumentSymbolAdapter<T extends ILanguageWorkerWithDocumentSymbols> implements monacoNS.languages.DocumentSymbolProvider {
  constructor(private readonly _worker: WorkerProxy<T>) {}

  async provideDocumentSymbols(
    model: monacoNS.editor.IReadOnlyModel,
  ): Promise<monacoNS.languages.DocumentSymbol[] | undefined> {
    const worker = await this._worker(model.uri);
    const items = await worker.findDocumentSymbols(model.uri.toString());
    if (items) {
      return items.map((item) => {
        if (isDocumentSymbol(item)) {
          return toDocumentSymbol(item);
        }
        return {
          name: item.name,
          detail: "",
          containerName: item.containerName,
          kind: toSymbolKind(item.kind),
          range: toRange(item.location.range),
          selectionRange: toRange(item.location.range),
          tags: item.tags ?? [],
        };
      });
    }
  }
}

function isDocumentSymbol(symbol: lst.SymbolInformation | lst.DocumentSymbol): symbol is lst.DocumentSymbol {
  return "children" in symbol;
}

function toDocumentSymbol(symbol: lst.DocumentSymbol): monacoNS.languages.DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: toSymbolKind(symbol.kind),
    range: toRange(symbol.range),
    selectionRange: toRange(symbol.selectionRange),
    tags: symbol.tags ?? [],
    children: (symbol.children ?? []).map((item) => toDocumentSymbol(item)),
    containerName: Reflect.get(symbol, "containerName"),
  };
}

function toSymbolKind(kind: lst.SymbolKind): monacoNS.languages.SymbolKind {
  const mKind = Monaco.languages.SymbolKind;
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

export class DefinitionAdapter<T extends ILanguageWorkerWithDefinitions> implements monacoNS.languages.DefinitionProvider {
  constructor(private readonly _worker: WorkerProxy<T>) {}

  async provideDefinition(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
  ): Promise<monacoNS.languages.Definition | undefined> {
    const worker = await this._worker(model.uri);
    const definition = await worker.findDefinition(model.uri.toString(), fromPosition(position));
    if (definition) {
      const links = (Array.isArray(definition) ? definition : [definition]).map(toLocationLink);
      await ensureHttpModels(links);
      return links;
    }
  }
}

function isLocationLink(location: lst.Location | lst.LocationLink): location is lst.LocationLink {
  return "targetUri" in location;
}

function toLocationLink(location: lst.Location | lst.LocationLink): monacoNS.languages.LocationLink {
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
  if (uri.includes(".__EMBEDDED__.")) {
    uri = uri.slice(0, uri.lastIndexOf(".__EMBEDDED__."));
  }
  return {
    uri: Monaco.Uri.parse(uri),
    range: toRange(range),
    originSelectionRange: originSelectionRange ? toRange(originSelectionRange) : undefined,
    targetSelectionRange: targetSelectionRange ? toRange(targetSelectionRange) : undefined,
  };
}

async function ensureHttpModels(links: monacoNS.languages.LocationLink[]): Promise<void> {
  const { editor, Uri } = Monaco;
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

export class ReferenceAdapter<T extends ILanguageWorkerWithReferences> implements monacoNS.languages.ReferenceProvider {
  constructor(private readonly _worker: WorkerProxy<T>) {}

  async provideReferences(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
    context: monacoNS.languages.ReferenceContext, // todo: use context.includeDeclaration
  ): Promise<monacoNS.languages.Location[] | undefined> {
    const worker = await this._worker(model.uri);
    const references = await worker.findReferences(model.uri.toString(), fromPosition(position));
    if (references) {
      const links = references.map(toLocationLink);
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

export class DocumentLinkAdapter<T extends ILanguageWorkerWithDocumentLinks> implements monacoNS.languages.LinkProvider {
  constructor(private _worker: WorkerProxy<T>) {}

  async provideLinks(
    model: monacoNS.editor.IReadOnlyModel,
  ): Promise<monacoNS.languages.ILinksList | undefined> {
    const worker = await this._worker(model.uri);
    const items = await worker.findDocumentLinks(model.uri.toString());
    if (items) {
      const links = items.map((item) => ({
        range: toRange(item.range),
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

export class DocumentColorAdapter<T extends ILanguageWorkerWithDocumentColors> implements monacoNS.languages.DocumentColorProvider {
  constructor(private readonly _worker: WorkerProxy<T>) {}

  async provideDocumentColors(
    model: monacoNS.editor.IReadOnlyModel,
  ): Promise<monacoNS.languages.IColorInformation[] | undefined> {
    const worker = await this._worker(model.uri);
    const colors = await worker.findDocumentColors(model.uri.toString());
    if (colors) {
      return colors.map((item) => ({
        color: item.color,
        range: toRange(item.range),
      }));
    }
  }

  async provideColorPresentations(
    model: monacoNS.editor.IReadOnlyModel,
    info: monacoNS.languages.IColorInformation,
  ): Promise<monacoNS.languages.IColorPresentation[] | undefined> {
    const worker = await this._worker(model.uri);
    const presentations = await worker.getColorPresentations(model.uri.toString(), info.color, fromRange(info.range));
    if (presentations) {
      return presentations.map((presentation) => ({
        label: presentation.label,
        textEdit: toTextEdit(presentation.textEdit),
        additionalTextEdits: presentation.additionalTextEdits?.map(toTextEdit),
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
> implements monacoNS.languages.DocumentHighlightProvider {
  constructor(private readonly _worker: WorkerProxy<T>) {}

  async provideDocumentHighlights(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
  ): Promise<monacoNS.languages.DocumentHighlight[] | undefined> {
    const worker = await this._worker(model.uri);
    const entries = await worker.findDocumentHighlights(model.uri.toString(), fromPosition(position));
    if (entries) {
      return entries.map((entry) => {
        return <monacoNS.languages.DocumentHighlight> {
          range: toRange(entry.range),
          kind: toDocumentHighlightKind(entry.kind),
        };
      });
    }
  }
}

function toDocumentHighlightKind(kind: lst.DocumentHighlightKind | undefined): monacoNS.languages.DocumentHighlightKind {
  switch (kind) {
    case lst.DocumentHighlightKind.Read:
      return Monaco.languages.DocumentHighlightKind.Read;
    case lst.DocumentHighlightKind.Write:
      return Monaco.languages.DocumentHighlightKind.Write;
    case lst.DocumentHighlightKind.Text:
      return Monaco.languages.DocumentHighlightKind.Text;
  }
  return Monaco.languages.DocumentHighlightKind.Text;
}

// #endregion

// #region FoldingRangeAdapter

export interface ILanguageWorkerWithFoldingRanges {
  getFoldingRanges(uri: string, context?: { rangeLimit?: number }): Promise<lst.FoldingRange[] | null>;
}

export class FoldingRangeAdapter<T extends ILanguageWorkerWithFoldingRanges> implements monacoNS.languages.FoldingRangeProvider {
  constructor(private _worker: WorkerProxy<T>) {}

  async provideFoldingRanges(
    model: monacoNS.editor.IReadOnlyModel,
    context: monacoNS.languages.FoldingContext,
  ): Promise<monacoNS.languages.FoldingRange[] | undefined> {
    const worker = await this._worker(model.uri);
    const ranges = await worker.getFoldingRanges(model.uri.toString(), context);
    if (ranges) {
      return ranges.map((range) => {
        const result: monacoNS.languages.FoldingRange = {
          start: range.startLine + 1,
          end: range.endLine + 1,
        };
        if (typeof range.kind !== "undefined") {
          result.kind = toFoldingRangeKind(range.kind);
        }
        return result;
      });
    }
  }
}

function toFoldingRangeKind(kind: lst.FoldingRangeKind): monacoNS.languages.FoldingRangeKind | undefined {
  switch (kind) {
    case lst.FoldingRangeKind.Comment:
      return Monaco.languages.FoldingRangeKind.Comment;
    case lst.FoldingRangeKind.Imports:
      return Monaco.languages.FoldingRangeKind.Imports;
    case lst.FoldingRangeKind.Region:
      return Monaco.languages.FoldingRangeKind.Region;
  }
  return undefined;
}

// #endregion

// #region SelectionRangeAdapter

export interface ILanguageWorkerWithSelectionRanges {
  getSelectionRanges(uri: string, positions: lst.Position[]): Promise<lst.SelectionRange[] | null>;
}

export class SelectionRangeAdapter<T extends ILanguageWorkerWithSelectionRanges> implements monacoNS.languages.SelectionRangeProvider {
  constructor(private _worker: WorkerProxy<T>) {}

  async provideSelectionRanges(
    model: monacoNS.editor.IReadOnlyModel,
    positions: monacoNS.Position[],
  ): Promise<monacoNS.languages.SelectionRange[][] | undefined> {
    const worker = await this._worker(model.uri);
    const selectionRanges = await worker.getSelectionRanges(model.uri.toString(), positions.map(fromPosition));
    if (selectionRanges) {
      return selectionRanges.map(
        (selectionRange: lst.SelectionRange | undefined) => {
          const result: monacoNS.languages.SelectionRange[] = [];
          while (selectionRange) {
            result.push({ range: toRange(selectionRange.range) });
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
  implements monacoNS.languages.LinkedEditingRangeProvider
{
  constructor(private _worker: WorkerProxy<T>) {}

  async provideLinkedEditingRanges(
    model: monacoNS.editor.ITextModel,
    position: monacoNS.Position,
  ): Promise<monacoNS.languages.LinkedEditingRanges | undefined> {
    const worker = await this._worker(model.uri);
    const linkedEditingRange = await worker.getLinkedEditingRangeAtPosition(
      model.uri.toString(),
      fromPosition(position),
    );
    if (linkedEditingRange) {
      const { wordPattern, ranges } = linkedEditingRange;
      return {
        ranges: ranges.map((range) => toRange(range)),
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

export class InlayHintsAdapter<T extends ILanguageWorkerWithInlayHints> implements monacoNS.languages.InlayHintsProvider {
  constructor(private _worker: WorkerProxy<T>) {}

  public async provideInlayHints(
    model: monacoNS.editor.ITextModel,
    range: monacoNS.Range,
  ): Promise<monacoNS.languages.InlayHintList> {
    const worker = await this._worker(model.uri);
    const ret = await worker.provideInlayHints(model.uri.toString(), fromRange(range));
    const hints: monacoNS.languages.InlayHint[] = [];
    if (ret) {
      for (const hint of ret) {
        hints.push(toInlayHint(hint));
      }
    }
    return { hints, dispose: () => {} };
  }
}

function toInlayHint(hint: lst.InlayHint): monacoNS.languages.InlayHint {
  return {
    label: toLabelText(hint.label),
    tooltip: hint.tooltip,
    textEdits: hint.textEdits?.map(toTextEdit),
    position: toPosition(hint.position),
    kind: hint.kind,
    paddingLeft: hint.paddingLeft,
    paddingRight: hint.paddingRight,
  };
}

function toLabelText(label: lst.InlayHintLabelPart[] | string): string | monacoNS.languages.InlayHintLabelPart[] {
  if (typeof label === "string") {
    return label;
  }
  return label.map(toInlayHintLabelPart);
}

function toInlayHintLabelPart(part: lst.InlayHintLabelPart): monacoNS.languages.InlayHintLabelPart {
  return {
    label: part.value,
    tooltip: part.tooltip,
    command: toCommand(part.command),
    location: toLocationLink(part.location),
  };
}

function toPosition(position: lst.Position): monacoNS.Position {
  return new Monaco.Position(position.line + 1, position.character + 1);
}

// #endregion
