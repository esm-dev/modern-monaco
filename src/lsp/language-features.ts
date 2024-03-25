/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) X. <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type monacoNS from "monaco-editor-core";
import * as lst from "vscode-languageserver-types";
let Monaco: typeof monacoNS;

export interface WorkerAccessor<T> {
  (...more: monacoNS.Uri[]): Promise<T>;
}

export function setup(monaco: typeof monacoNS) {
  monaco.editor.addCommand({
    id: "search-npm-modules",
    run: async (_, importMapSrc: string) => {
      alert("TODO: search-npm-modules");
    },
  });
  Monaco = monaco;
}

export function registerDefault(
  languageId: string,
  workerAccessor: WorkerAccessor<any>,
  completionTriggerCharacters: string[],
) {
  const { languages } = Monaco;
  languages.registerCompletionItemProvider(
    languageId,
    new CompletionAdapter(workerAccessor, completionTriggerCharacters),
  );
  languages.registerDocumentFormattingEditProvider(
    languageId,
    new DocumentFormattingEditProvider(workerAccessor),
  );
  languages.registerDocumentRangeFormattingEditProvider(
    languageId,
    new DocumentRangeFormattingEditProvider(workerAccessor),
  );
  languages.registerDocumentSymbolProvider(
    languageId,
    new DocumentSymbolAdapter(workerAccessor),
  );
  languages.registerFoldingRangeProvider(
    languageId,
    new FoldingRangeAdapter(workerAccessor),
  );
  languages.registerHoverProvider(
    languageId,
    new HoverAdapter(workerAccessor),
  );
  languages.registerSelectionRangeProvider(
    languageId,
    new SelectionRangeAdapter(workerAccessor),
  );
}

// #region EmbeddedLanguages

export interface ILanguageWorkerWithEmbeddedSupport {
  getEmbeddedDocument(uri: string, langaugeId: string): Promise<{ content: string } | null>;
}

export function attachEmbeddedLanguages<T extends ILanguageWorkerWithEmbeddedSupport>(
  worker: WorkerAccessor<T>,
  embeddedLanguages: string[],
) {
  const { editor, Uri } = Monaco;
  const validateModel = async (model: monacoNS.editor.IModel) => {
    const getEmbeddedDocument = (languageId: string) =>
      worker(model.uri).then((worker) => worker.getEmbeddedDocument(model.uri.toString(), languageId));
    const attachEmbeddedLanguage = async (languageId: string) => {
      const uri = Uri.parse(model.uri.toString() + "#" + languageId);
      const doc = await getEmbeddedDocument(languageId);
      if (doc) {
        const model = editor.getModel(uri);
        if (!model) {
          editor.createModel(doc.content, languageId === "importmap" ? "json" : languageId, uri);
        } else {
          model.setValue(doc.content);
        }
      } else {
        const model = editor.getModel(uri);
        if (model) {
          model.dispose();
        }
      }
    };
    embeddedLanguages.forEach(attachEmbeddedLanguage);
    model.onDidChangeContent(() => {
      embeddedLanguages.forEach(attachEmbeddedLanguage);
    });
  };
  const cleanUp = (model: monacoNS.editor.IModel) => {
    embeddedLanguages.forEach((languageId) => {
      const uri = Uri.parse(model.uri.toString() + "#" + languageId);
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

export interface ILanguageWorkerWithDiagnostics {
  doValidation(uri: string): Promise<lst.Diagnostic[]>;
}

export class DiagnosticsAdapter<T extends ILanguageWorkerWithDiagnostics> {
  private readonly _listeners: { [uri: string]: monacoNS.IDisposable } = Object.create(null);

  constructor(
    private readonly _languageId: string,
    protected readonly _worker: WorkerAccessor<T>,
    onRefresh: monacoNS.IEvent<any>,
  ) {
    const { editor } = Monaco;
    const validateModel = (model: monacoNS.editor.IModel): void => {
      let modeId = model.getLanguageId();
      if (modeId !== this._languageId) {
        return;
      }

      let handle: number;
      this._listeners[model.uri.toString()] = model.onDidChangeContent(() => {
        window.clearTimeout(handle);
        handle = window.setTimeout(
          () => this._doValidate(model.uri, modeId),
          500,
        );
      });

      this._doValidate(model.uri, modeId);
    };

    const dispose = (model: monacoNS.editor.IModel): void => {
      const key = model.uri.toString();
      if (this._listeners[key]) {
        this._listeners[key].dispose();
        delete this._listeners[key];
      }
    };

    editor.onDidCreateModel(validateModel);
    editor.onWillDisposeModel((model) => {
      dispose(model);
      editor.setModelMarkers(model, this._languageId, []);
    });
    editor.onDidChangeModelLanguage(({ model }) => {
      dispose(model);
      validateModel(model);
    });
    onRefresh((_) => {
      editor.getModels().forEach((model) => {
        dispose(model);
        validateModel(model);
      });
    });
    editor.getModels().forEach(validateModel);
  }

  private _doValidate(uri: monacoNS.Uri, languageId: string): void {
    this._worker(uri)
      .then((worker) => {
        return worker.doValidation(uri.toString());
      })
      .then((diagnostics) => {
        const markers = diagnostics.map(toDiagnostics);
        const model = Monaco.editor.getModel(uri);
        if (model && model.getLanguageId() === languageId) {
          Monaco.editor.setModelMarkers(model, languageId, markers);
        }
      })
      .catch((err) => {
        console.error(err);
      });
  }
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

function toDiagnostics(diag: lst.Diagnostic): monacoNS.editor.IMarkerData {
  const code = typeof diag.code === "number" ? String(diag.code) : <string> diag.code;
  return {
    severity: toSeverity(diag.severity),
    startLineNumber: diag.range.start.line + 1,
    startColumn: diag.range.start.character + 1,
    endLineNumber: diag.range.end.line + 1,
    endColumn: diag.range.end.character + 1,
    message: diag.message,
    code: code,
    source: diag.source,
  };
}

// #endregion

// #region CompletionAdapter

export interface ILanguageWorkerWithCompletions {
  doComplete(
    uri: string,
    position: lst.Position,
  ): Promise<lst.CompletionList | null>;
}

export class CompletionAdapter<T extends ILanguageWorkerWithCompletions>
  implements monacoNS.languages.CompletionItemProvider
{
  constructor(
    private readonly _worker: WorkerAccessor<T>,
    private readonly _triggerCharacters: string[],
  ) {}

  public get triggerCharacters(): string[] {
    return this._triggerCharacters;
  }

  provideCompletionItems(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
    context: monacoNS.languages.CompletionContext,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.CompletionList | undefined> {
    const resource = model.uri;

    return this._worker(resource)
      .then((worker) => {
        return worker.doComplete(resource.toString(), fromPosition(position));
      })
      .then((info) => {
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
          const item: monacoNS.languages.CompletionItem = {
            label: entry.label,
            insertText: entry.insertText || entry.label,
            sortText: entry.sortText,
            filterText: entry.filterText,
            documentation: entry.documentation,
            detail: entry.detail,
            command: toCommand(entry.command),
            range: wordRange,
            kind: toCompletionItemKind(entry.kind),
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
            item.additionalTextEdits = entry.additionalTextEdits.map<
              monacoNS.languages.TextEdit
            >(toTextEdit);
          }
          if (entry.insertTextFormat === lst.InsertTextFormat.Snippet) {
            item.insertTextRules = Monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
          }
          return item;
        });

        return {
          isIncomplete: info.isIncomplete,
          suggestions: items,
        };
      });
  }
}

export function fromPosition(position: monacoNS.Position): lst.Position;
export function fromPosition(position: undefined): undefined;
export function fromPosition(
  position: monacoNS.Position | undefined,
): lst.Position | undefined;
export function fromPosition(
  position: monacoNS.Position | undefined,
): lst.Position | undefined {
  if (!position) {
    return void 0;
  }
  return { character: position.column - 1, line: position.lineNumber - 1 };
}

export function fromRange(range: monacoNS.IRange): lst.Range;
export function fromRange(range: undefined): undefined;
export function fromRange(range: monacoNS.IRange | undefined): lst.Range | undefined;
export function fromRange(
  range: monacoNS.IRange | undefined,
): lst.Range | undefined {
  if (!range) {
    return void 0;
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
    return void 0;
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
export function toTextEdit(
  textEdit: lst.TextEdit | undefined,
): monacoNS.languages.TextEdit | undefined;
export function toTextEdit(
  textEdit: lst.TextEdit | undefined,
): monacoNS.languages.TextEdit | undefined {
  if (!textEdit) {
    return void 0;
  }
  return {
    range: toRange(textEdit.range),
    text: textEdit.newText,
  };
}

function toCommand(
  c: lst.Command | undefined,
): monacoNS.languages.Command | undefined {
  return c && c.command === "editor.action.triggerSuggest"
    ? { id: c.command, title: c.title, arguments: c.arguments }
    : undefined;
}

// #endregion

// #region HoverAdapter

export interface ILanguageWorkerWithHover {
  doHover(
    uri: string,
    position: lst.Position,
  ): Promise<lst.Hover | null>;
}

export class HoverAdapter<T extends ILanguageWorkerWithHover> implements monacoNS.languages.HoverProvider {
  constructor(private readonly _worker: WorkerAccessor<T>) {}

  provideHover(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.Hover | undefined> {
    let resource = model.uri;

    return this._worker(resource)
      .then((worker) => {
        return worker.doHover(resource.toString(), fromPosition(position));
      })
      .then((info) => {
        if (!info) {
          return;
        }
        return <monacoNS.languages.Hover> {
          range: toRange(info.range),
          contents: toMarkedStringArray(info.contents),
        };
      });
  }
}

function isMarkupContent(thing: any): thing is lst.MarkupContent {
  return (
    thing && typeof thing === "object"
    && typeof (<lst.MarkupContent> thing).kind === "string"
  );
}

function toMarkdownString(
  entry: lst.MarkupContent | lst.MarkedString,
): monacoNS.IMarkdownString {
  if (typeof entry === "string") {
    return {
      value: entry,
    };
  }
  if (isMarkupContent(entry)) {
    if (entry.kind === "plaintext") {
      return {
        value: entry.value.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&"),
      };
    }
    return {
      value: entry.value,
    };
  }

  return { value: "```" + entry.language + "\n" + entry.value + "\n```\n" };
}

function toMarkedStringArray(
  contents:
    | lst.MarkupContent
    | lst.MarkedString
    | lst.MarkedString[],
): monacoNS.IMarkdownString[] | undefined {
  if (!contents) {
    return void 0;
  }
  if (Array.isArray(contents)) {
    return contents.map(toMarkdownString);
  }
  return [toMarkdownString(contents)];
}

// #endregion

// #region DocumentHighlightAdapter

export interface ILanguageWorkerWithDocumentHighlights {
  findDocumentHighlights(
    uri: string,
    position: lst.Position,
  ): Promise<lst.DocumentHighlight[]>;
}

export class DocumentHighlightAdapter<
  T extends ILanguageWorkerWithDocumentHighlights,
> implements monacoNS.languages.DocumentHighlightProvider {
  constructor(private readonly _worker: WorkerAccessor<T>) {}

  public provideDocumentHighlights(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.DocumentHighlight[] | undefined> {
    const resource = model.uri;

    return this._worker(resource)
      .then((worker) =>
        worker.findDocumentHighlights(
          resource.toString(),
          fromPosition(position),
        )
      )
      .then((entries) => {
        if (!entries) {
          return;
        }
        return entries.map((entry) => {
          return <monacoNS.languages.DocumentHighlight> {
            range: toRange(entry.range),
            kind: toDocumentHighlightKind(entry.kind),
          };
        });
      });
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

// #region DefinitionAdapter

export interface ILanguageWorkerWithDefinitions {
  findDefinition(
    uri: string,
    position: lst.Position,
  ): Promise<lst.Location | null>;
}

export class DefinitionAdapter<T extends ILanguageWorkerWithDefinitions>
  implements monacoNS.languages.DefinitionProvider
{
  constructor(private readonly _worker: WorkerAccessor<T>) {}

  public provideDefinition(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.Definition | undefined> {
    const resource = model.uri;

    return this._worker(resource)
      .then((worker) => {
        return worker.findDefinition(
          resource.toString(),
          fromPosition(position),
        );
      })
      .then((definition) => {
        if (!definition) {
          return;
        }
        return [toLocation(definition)];
      });
  }
}

function toLocation(location: lst.Location): monacoNS.languages.Location {
  return {
    uri: Monaco.Uri.parse(location.uri),
    range: toRange(location.range),
  };
}

// #endregion

// #region ReferenceAdapter

export interface ILanguageWorkerWithReferences {
  findReferences(
    uri: string,
    position: lst.Position,
  ): Promise<lst.Location[]>;
}

export class ReferenceAdapter<T extends ILanguageWorkerWithReferences> implements monacoNS.languages.ReferenceProvider {
  constructor(private readonly _worker: WorkerAccessor<T>) {}

  provideReferences(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
    context: monacoNS.languages.ReferenceContext,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.Location[] | undefined> {
    const resource = model.uri;

    return this._worker(resource)
      .then((worker) => {
        return worker.findReferences(
          resource.toString(),
          fromPosition(position),
        );
      })
      .then((entries) => {
        if (!entries) {
          return;
        }
        return entries.map(toLocation);
      });
  }
}

// #endregion

// #region RenameAdapter

export interface ILanguageWorkerWithRename {
  doRename(
    uri: string,
    position: lst.Position,
    newName: string,
  ): Promise<lst.WorkspaceEdit | null>;
}

export class RenameAdapter<T extends ILanguageWorkerWithRename> implements monacoNS.languages.RenameProvider {
  constructor(private readonly _worker: WorkerAccessor<T>) {}

  provideRenameEdits(
    model: monacoNS.editor.IReadOnlyModel,
    position: monacoNS.Position,
    newName: string,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.WorkspaceEdit | undefined> {
    const resource = model.uri;

    return this._worker(resource)
      .then((worker) => {
        return worker.doRename(
          resource.toString(),
          fromPosition(position),
          newName,
        );
      })
      .then((edit) => {
        return toWorkspaceEdit(edit);
      });
  }
}

function toWorkspaceEdit(
  edit: lst.WorkspaceEdit | null,
): monacoNS.languages.WorkspaceEdit | undefined {
  if (!edit || !edit.changes) {
    return void 0;
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
  return {
    edits: resourceEdits,
  };
}

// #endregion

// #region DocumentSymbolAdapter

export interface ILanguageWorkerWithDocumentSymbols {
  findDocumentSymbols(
    uri: string,
  ): Promise<lst.SymbolInformation[] | lst.DocumentSymbol[]>;
}

export class DocumentSymbolAdapter<T extends ILanguageWorkerWithDocumentSymbols>
  implements monacoNS.languages.DocumentSymbolProvider
{
  constructor(private readonly _worker: WorkerAccessor<T>) {}

  public provideDocumentSymbols(
    model: monacoNS.editor.IReadOnlyModel,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.DocumentSymbol[] | undefined> {
    const resource = model.uri;

    return this._worker(resource)
      .then((worker) => worker.findDocumentSymbols(resource.toString()))
      .then((items) => {
        if (!items) {
          return;
        }
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
            tags: [],
          };
        });
      });
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
  };
}

function toSymbolKind(kind: lst.SymbolKind): monacoNS.languages.SymbolKind {
  let mKind = Monaco.languages.SymbolKind;

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
  findDocumentLinks(uri: string): Promise<lst.DocumentLink[]>;
}

export class DocumentLinkAdapter<T extends ILanguageWorkerWithDocumentLinks>
  implements monacoNS.languages.LinkProvider
{
  constructor(private _worker: WorkerAccessor<T>) {}

  public provideLinks(
    model: monacoNS.editor.IReadOnlyModel,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.ILinksList | undefined> {
    const resource = model.uri;

    return this._worker(resource)
      .then((worker) => worker.findDocumentLinks(resource.toString()))
      .then((items) => {
        if (!items) {
          return;
        }
        return {
          links: items.map((item) => ({
            range: toRange(item.range),
            url: item.target,
          })),
        };
      });
  }
}

// #endregion

// #region DocumentFormattingEditProvider, DocumentRangeFormattingEditProvider

export interface ILanguageWorkerWithFormat {
  format(
    uri: string,
    range: lst.Range | null,
    options: lst.FormattingOptions,
    docText?: string,
  ): Promise<lst.TextEdit[]>;
}

export class DocumentFormattingEditProvider<T extends ILanguageWorkerWithFormat>
  implements monacoNS.languages.DocumentFormattingEditProvider
{
  constructor(private _worker: WorkerAccessor<T>) {}

  public provideDocumentFormattingEdits(
    model: monacoNS.editor.IReadOnlyModel,
    options: monacoNS.languages.FormattingOptions,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.TextEdit[] | undefined> {
    const resource = model.uri;

    return this._worker(resource).then((worker) => {
      return worker
        .format(resource.toString(), null, fromFormattingOptions(options))
        .then((edits) => {
          if (!edits || edits.length === 0) {
            return;
          }
          return edits.map<monacoNS.languages.TextEdit>(toTextEdit);
        });
    });
  }
}

export class DocumentRangeFormattingEditProvider<T extends ILanguageWorkerWithFormat>
  implements monacoNS.languages.DocumentRangeFormattingEditProvider
{
  readonly canFormatMultipleRanges = false;

  constructor(private _worker: WorkerAccessor<T>) {}

  public provideDocumentRangeFormattingEdits(
    model: monacoNS.editor.IReadOnlyModel,
    range: monacoNS.Range,
    options: monacoNS.languages.FormattingOptions,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.TextEdit[] | undefined> {
    const resource = model.uri;

    return this._worker(resource).then((worker) => {
      return worker
        .format(
          resource.toString(),
          fromRange(range),
          fromFormattingOptions(options),
        )
        .then((edits) => {
          if (!edits || edits.length === 0) {
            return;
          }
          return edits.map<monacoNS.languages.TextEdit>(toTextEdit);
        });
    });
  }
}

function fromFormattingOptions(options: monacoNS.languages.FormattingOptions): lst.FormattingOptions {
  return {
    tabSize: options.tabSize,
    insertSpaces: options.insertSpaces,
  };
}

// #endregion

// #region DocumentColorAdapter

export interface ILanguageWorkerWithDocumentColors {
  findDocumentColors(uri: string): Promise<lst.ColorInformation[]>;
  getColorPresentations(uri: string, color: lst.Color, range: lst.Range): Promise<lst.ColorPresentation[]>;
}

export class DocumentColorAdapter<T extends ILanguageWorkerWithDocumentColors>
  implements monacoNS.languages.DocumentColorProvider
{
  constructor(private readonly _worker: WorkerAccessor<T>) {}

  public provideDocumentColors(
    model: monacoNS.editor.IReadOnlyModel,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.IColorInformation[] | undefined> {
    const resource = model.uri;

    return this._worker(resource)
      .then((worker) => worker.findDocumentColors(resource.toString()))
      .then((infos) => {
        if (!infos) {
          return;
        }
        return infos.map((item) => ({
          color: item.color,
          range: toRange(item.range),
        }));
      });
  }

  public provideColorPresentations(
    model: monacoNS.editor.IReadOnlyModel,
    info: monacoNS.languages.IColorInformation,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.IColorPresentation[] | undefined> {
    const resource = model.uri;

    return this._worker(resource)
      .then((worker) =>
        worker.getColorPresentations(
          resource.toString(),
          info.color,
          fromRange(info.range),
        )
      )
      .then((presentations) => {
        if (!presentations) {
          return;
        }
        return presentations.map((presentation) => {
          let item: monacoNS.languages.IColorPresentation = {
            label: presentation.label,
          };
          if (presentation.textEdit) {
            item.textEdit = toTextEdit(presentation.textEdit);
          }
          if (presentation.additionalTextEdits) {
            item.additionalTextEdits = presentation.additionalTextEdits.map<
              monacoNS.languages.TextEdit
            >(toTextEdit);
          }
          return item;
        });
      });
  }
}

// #endregion

// #region FoldingRangeAdapter

export interface ILanguageWorkerWithFoldingRanges {
  getFoldingRanges(
    uri: string,
    context?: { rangeLimit?: number },
  ): Promise<lst.FoldingRange[]>;
}

export class FoldingRangeAdapter<T extends ILanguageWorkerWithFoldingRanges>
  implements monacoNS.languages.FoldingRangeProvider
{
  constructor(private _worker: WorkerAccessor<T>) {}

  public provideFoldingRanges(
    model: monacoNS.editor.IReadOnlyModel,
    context: monacoNS.languages.FoldingContext,
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.FoldingRange[] | undefined> {
    const resource = model.uri;

    return this._worker(resource)
      .then((worker) => worker.getFoldingRanges(resource.toString(), context))
      .then((ranges) => {
        if (!ranges) {
          return;
        }
        return ranges.map((range) => {
          const result: monacoNS.languages.FoldingRange = {
            start: range.startLine + 1,
            end: range.endLine + 1,
          };
          if (typeof range.kind !== "undefined") {
            result.kind = toFoldingRangeKind(
              <lst.FoldingRangeKind> range.kind,
            );
          }
          return result;
        });
      });
  }
}

function toFoldingRangeKind(
  kind: lst.FoldingRangeKind,
): monacoNS.languages.FoldingRangeKind | undefined {
  switch (kind) {
    case lst.FoldingRangeKind.Comment:
      return Monaco.languages.FoldingRangeKind.Comment;
    case lst.FoldingRangeKind.Imports:
      return Monaco.languages.FoldingRangeKind.Imports;
    case lst.FoldingRangeKind.Region:
      return Monaco.languages.FoldingRangeKind.Region;
  }
  return void 0;
}

// #endregion

// #region SelectionRangeAdapter

export interface ILanguageWorkerWithSelectionRanges {
  getSelectionRanges(
    uri: string,
    positions: lst.Position[],
  ): Promise<lst.SelectionRange[]>;
}

export class SelectionRangeAdapter<T extends ILanguageWorkerWithSelectionRanges>
  implements monacoNS.languages.SelectionRangeProvider
{
  constructor(private _worker: WorkerAccessor<T>) {}

  public provideSelectionRanges(
    model: monacoNS.editor.IReadOnlyModel,
    positions: monacoNS.Position[],
    token: monacoNS.CancellationToken,
  ): Promise<monacoNS.languages.SelectionRange[][] | undefined> {
    const resource = model.uri;

    return this._worker(resource)
      .then((worker) =>
        worker.getSelectionRanges(
          resource.toString(),
          positions.map<lst.Position>(fromPosition),
        )
      )
      .then((selectionRanges) => {
        if (!selectionRanges) {
          return;
        }
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
      });
  }
}

// #endregion
