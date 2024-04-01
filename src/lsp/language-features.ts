/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) X. <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type monacoNS from "monaco-editor-core";
import * as lst from "vscode-languageserver-types";
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
    & ILanguageWorkerWithDocumentSymbols
    & ILanguageWorkerWithFoldingRanges
    & ILanguageWorkerWithSelectionRanges,
>(
  languageId: string,
  workerProxy: WorkerProxy<T>,
  completionTriggerCharacters: string[],
  noFoldingRangeAdapter?: boolean,
) {
  const { languages, Emitter } = Monaco;

  // create diagnostics adapter
  const refreshEmitter = new Emitter<void>();
  new DiagnosticsAdapter(languageId, workerProxy, refreshEmitter.event);
  refreshEmitters.set(languageId, refreshEmitter);

  // register language features
  languages.registerCompletionItemProvider(languageId, new CompletionAdapter(workerProxy, completionTriggerCharacters));
  languages.registerHoverProvider(languageId, new HoverAdapter(workerProxy));
  languages.registerDocumentSymbolProvider(languageId, new DocumentSymbolAdapter(workerProxy));
  languages.registerDocumentFormattingEditProvider(languageId, new DocumentFormattingEditProvider(workerProxy));
  languages.registerDocumentRangeFormattingEditProvider(languageId, new DocumentRangeFormattingEditProvider(workerProxy));
  languages.registerSelectionRangeProvider(languageId, new SelectionRangeAdapter(workerProxy));
  if (!noFoldingRangeAdapter) {
    languages.registerFoldingRangeProvider(languageId, new FoldingRangeAdapter(workerProxy));
  }
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
  worker: WorkerProxy<T>,
  embeddedLanguages: Record<string, string>,
) {
  const { editor, Uri } = Monaco;
  const embeddedLanguageIds = Object.keys(embeddedLanguages);
  const toEbeddedUri = (model: monacoNS.editor.IModel, languageId: string) => {
    return Uri.parse(model.uri.path + ".__EMBEDDED__." + embeddedLanguages[languageId]);
  };
  const validateModel = async (model: monacoNS.editor.IModel) => {
    if (model.getLanguageId() !== "html") {
      return;
    }
    const getEmbeddedDocument = (languageId: string) => worker(model.uri).then((worker) => worker.getEmbeddedDocument(model.uri.toString(), languageId));

    const attachEmbeddedLanguage = async (languageId: string) => {
      const uri = toEbeddedUri(model, languageId);
      const doc = await getEmbeddedDocument(languageId);
      if (doc) {
        const emebeddedModel = editor.getModel(uri);
        if (!emebeddedModel) {
          editor.createModel(doc.content, languageId === "importmap" ? "json" : languageId, uri);
        } else {
          emebeddedModel.setValue(doc.content);
        }
      } else {
        const emebeddedModel = editor.getModel(uri);
        if (emebeddedModel) {
          emebeddedModel.dispose();
        }
      }
    };
    embeddedLanguageIds.forEach(attachEmbeddedLanguage);
    model.onDidChangeContent(() => {
      embeddedLanguageIds.forEach(attachEmbeddedLanguage);
    });
  };
  const cleanUp = (model: monacoNS.editor.IModel) => {
    embeddedLanguageIds.forEach((languageId) => {
      const uri = toEbeddedUri(model, languageId);
      editor.getModel(uri)?.dispose();
    });
  };
  editor.onDidCreateModel(validateModel);
  editor.onWillDisposeModel((model) => {
    cleanUp(model);
  });
  editor.onDidChangeModelLanguage(({ model }) => {
    cleanUp(model);
    validateModel(model);
  });
  editor.getModels().forEach(validateModel);
}

// #endregion

// #region DiagnosticsAdapter

export interface ILanguageWorkerWithValidation {
  doValidation(uri: string): Promise<lst.Diagnostic[] | null>;
}

export class DiagnosticsAdapter<T extends ILanguageWorkerWithValidation> {
  private readonly _listeners: { [uri: string]: monacoNS.IDisposable } = Object.create(null);

  constructor(
    private readonly _languageId: string,
    private readonly _worker: WorkerProxy<T>,
    onRefresh: monacoNS.IEvent<void>,
  ) {
    const validateModel = (model: monacoNS.editor.IModel): void => {
      const modelId = model.getLanguageId();
      const uri = model.uri.toString();
      if (modelId !== this._languageId || uri.includes(".__EMBEDDED__.")) {
        return;
      }

      let timer: number | null = null;
      this._listeners[uri] = model.onDidChangeContent(() => {
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          timer = null;
          this._doValidate(model);
        }, 500);
      });
      this._doValidate(model);
    };

    const dispose = (model: monacoNS.editor.IModel): void => {
      const key = model.uri.toString();
      if (this._listeners[key]) {
        this._listeners[key].dispose();
        delete this._listeners[key];
      }
    };

    const { editor } = Monaco;

    editor.onDidCreateModel(validateModel);
    editor.onWillDisposeModel((model) => {
      dispose(model);
      editor.setModelMarkers(model, this._languageId, []);
    });
    editor.onDidChangeModelLanguage(({ model }) => {
      dispose(model);
      validateModel(model);
    });
    onRefresh(() => {
      editor.getModels().forEach((model) => {
        dispose(model);
        validateModel(model);
      });
    });
    editor.getModels().forEach(validateModel);
  }

  private async _doValidate(model: monacoNS.editor.ITextModel): Promise<void> {
    const worker = await this._worker(model.uri);
    const diagnostics = await worker.doValidation(model.uri.toString());
    if (diagnostics && !model.isDisposed()) {
      const markers = diagnostics.map(toMarker);
      Monaco.editor.setModelMarkers(model, this._languageId, markers);
    }
  }
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
    context: monacoNS.languages.CompletionContext,
    token: monacoNS.CancellationToken,
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
    token: monacoNS.CancellationToken,
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
    typeof (<lst.InsertReplaceEdit> edit).insert !== "undefined"
    && typeof (<lst.InsertReplaceEdit> edit).replace !== "undefined"
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
    token: monacoNS.CancellationToken,
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
    token: monacoNS.CancellationToken,
    context: monacoNS.languages.SignatureHelpContext,
  ): Promise<monacoNS.languages.SignatureHelpResult | undefined> {
    const resource = model.uri;
    const offset = model.getOffsetAt(position);
    const worker = await this._worker(resource);
    const helpInfo = await worker.doSignatureHelp(resource.toString(), offset, context);
    if (!helpInfo || model.isDisposed()) {
      return undefined;
    }
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
    errorCodes: number[],
    formatOptions: lst.FormattingOptions,
  ): Promise<lst.CodeAction[] | null>;
}

export class CodeActionAdaptor<T extends ILanguageWorkerWithCodeAction> implements monacoNS.languages.CodeActionProvider {
  constructor(private readonly _worker: WorkerProxy<T>) {}

  public async provideCodeActions(
    model: monacoNS.editor.ITextModel,
    range: monacoNS.Range,
    context: monacoNS.languages.CodeActionContext,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.CodeActionList | undefined> {
    const errorCodes = context.markers.filter((m) => m.code).map((m) => m.code).map(Number);
    const modelOptions = model.getOptions();
    const formatOptions: lst.FormattingOptions = {
      tabSize: modelOptions.tabSize,
      insertSpaces: modelOptions.insertSpaces,
    };
    const worker = await this._worker(model.uri);
    const codeActions = await worker.doCodeAction(model.uri.toString(), fromRange(range), errorCodes, formatOptions);
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
    token: monacoNS.CancellationToken,
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

export class DocumentFormattingEditProvider<T extends ILanguageWorkerWithFormat> implements monacoNS.languages.DocumentFormattingEditProvider {
  constructor(private _worker: WorkerProxy<T>) {}

  async provideDocumentFormattingEdits(
    model: monacoNS.editor.IReadOnlyModel,
    options: monacoNS.languages.FormattingOptions,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.TextEdit[] | undefined> {
    const worker = await this._worker(model.uri);
    const edits = await worker.doFormat(model.uri.toString(), null, options as lst.FormattingOptions);
    if (edits) {
      return edits.map<monacoNS.languages.TextEdit>(toTextEdit);
    }
  }
}

export class DocumentRangeFormattingEditProvider<T extends ILanguageWorkerWithFormat> implements monacoNS.languages.DocumentRangeFormattingEditProvider {
  constructor(private _worker: WorkerProxy<T>) {}

  async provideDocumentRangeFormattingEdits(
    model: monacoNS.editor.IReadOnlyModel,
    range: monacoNS.Range,
    options: monacoNS.languages.FormattingOptions,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.TextEdit[] | undefined> {
    const worker = await this._worker(model.uri);
    const edits = await worker.doFormat(model.uri.toString(), fromRange(range), options as lst.FormattingOptions);
    if (edits) {
      return edits.map<monacoNS.languages.TextEdit>(toTextEdit);
    }
  }
}

// #endregion

// #region DefinitionAdapter

export interface ILanguageWorkerWithDefinitions {
  findDefinition(
    uri: string,
    position: lst.Position,
  ): Promise<(lst.Location & { originSelectionRange?: lst.Range })[] | null>;
}

export class DefinitionAdapter<T extends ILanguageWorkerWithDefinitions> implements monacoNS.languages.DefinitionProvider {
  constructor(private readonly _worker: WorkerProxy<T>) {}

  async provideDefinition(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.Definition | undefined> {
    const worker = await this._worker(model.uri);
    const definition = await worker.findDefinition(model.uri.toString(), fromPosition(position));
    if (definition) {
      return (Array.isArray(definition) ? definition : [definition]).map(location => {
        const link = toLocationLink(location);
        return link;
      });
    }
  }
}

function toLocationLink(
  location: lst.Location & { originSelectionRange?: lst.Range },
): monacoNS.languages.LocationLink {
  let uri = location.uri;
  if (uri.includes(".__EMBEDDED__.")) {
    uri = uri.slice(0, uri.lastIndexOf(".__EMBEDDED__."));
  }
  return {
    originSelectionRange: location.originSelectionRange ? toRange(location.originSelectionRange) : undefined,
    uri: Monaco.Uri.parse(uri),
    range: toRange(location.range),
  };
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
    context: monacoNS.languages.ReferenceContext,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.Location[] | undefined> {
    const worker = await this._worker(model.uri);
    const references = await worker.findReferences(model.uri.toString(), fromPosition(position));
    if (references) {
      return references.map(toLocationLink);
    }
  }
}

// #endregion

// #region DocumentSymbolAdapter

export interface ILanguageWorkerWithDocumentSymbols {
  findDocumentSymbols(uri: string): Promise<(lst.SymbolInformation | lst.DocumentSymbol)[] | null>;
}

export class DocumentSymbolAdapter<T extends ILanguageWorkerWithDocumentSymbols> implements monacoNS.languages.DocumentSymbolProvider {
  constructor(private readonly _worker: WorkerProxy<T>) {}

  async provideDocumentSymbols(
    model: monacoNS.editor.IReadOnlyModel,
    token: monacoNS.CancellationToken,
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

// #region DocumentLinkAdapter

export interface ILanguageWorkerWithDocumentLinks {
  findDocumentLinks(uri: string): Promise<lst.DocumentLink[] | null>;
}

export class DocumentLinkAdapter<T extends ILanguageWorkerWithDocumentLinks> implements monacoNS.languages.LinkProvider {
  constructor(private _worker: WorkerProxy<T>) {}

  async provideLinks(
    model: monacoNS.editor.IReadOnlyModel,
    token: monacoNS.CancellationToken,
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
    token: monacoNS.CancellationToken,
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
    token: monacoNS.CancellationToken,
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
    token: monacoNS.CancellationToken,
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

function toDocumentHighlightKind(
  kind: lst.DocumentHighlightKind | undefined,
): monacoNS.languages.DocumentHighlightKind {
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
    token: monacoNS.CancellationToken,
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
    token: monacoNS.CancellationToken,
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

export class LinkedEditingRangeAdapter<T extends ILanguageWorkerWithLinkedEditingRange> implements monacoNS.languages.LinkedEditingRangeProvider {
  constructor(private _worker: WorkerProxy<T>) {}

  async provideLinkedEditingRanges(
    model: monacoNS.editor.ITextModel,
    position: monacoNS.Position,
    token: monacoNS.CancellationToken,
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
    token: monacoNS.CancellationToken,
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
