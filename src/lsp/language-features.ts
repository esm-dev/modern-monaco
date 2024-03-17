/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) X. <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type monacoNS from "monaco-editor-core";
import * as lsTypes from "vscode-languageserver-types";

let Monaco: typeof monacoNS;
export function prelude(monaco: typeof monacoNS) {
  monaco.editor.addCommand({
    id: "search-npm-modules",
    run: async (_, importMapSrc: string) => {
      alert("TODO: search-npm-modules");
    },
  });
  Monaco = monaco;
}

export interface WorkerAccessor<T> {
  (...more: monacoNS.Uri[]): Promise<T>;
}

// #region DiagnosticsAdapter

export interface ILanguageWorkerWithDiagnostics {
  doValidation(uri: string): Promise<lsTypes.Diagnostic[]>;
}

export class DiagnosticsAdapter<T extends ILanguageWorkerWithDiagnostics> {
  protected readonly _disposables: monacoNS.IDisposable[] = [];
  private readonly _listener: { [uri: string]: monacoNS.IDisposable } = Object.create(
    null,
  );

  constructor(
    private readonly _languageId: string,
    protected readonly _worker: WorkerAccessor<T>,
    configChangeEvent: monacoNS.IEvent<any>,
  ) {
    const onModelAdd = (model: monacoNS.editor.IModel): void => {
      let modeId = model.getLanguageId();
      if (modeId !== this._languageId) {
        return;
      }

      let handle: number;
      this._listener[model.uri.toString()] = model.onDidChangeContent(() => {
        window.clearTimeout(handle);
        handle = window.setTimeout(
          () => this._doValidate(model.uri, modeId),
          500,
        );
      });

      this._doValidate(model.uri, modeId);
    };

    const onModelRemoved = (model: monacoNS.editor.IModel): void => {
      Monaco.editor.setModelMarkers(model, this._languageId, []);

      let uriStr = model.uri.toString();
      let listener = this._listener[uriStr];
      if (listener) {
        listener.dispose();
        delete this._listener[uriStr];
      }
    };

    this._disposables.push(Monaco.editor.onDidCreateModel(onModelAdd));
    this._disposables.push(Monaco.editor.onWillDisposeModel(onModelRemoved));
    this._disposables.push(
      Monaco.editor.onDidChangeModelLanguage((event) => {
        onModelRemoved(event.model);
        onModelAdd(event.model);
      }),
    );

    this._disposables.push(
      configChangeEvent((_) => {
        Monaco.editor.getModels().forEach((model) => {
          if (model.getLanguageId() === this._languageId) {
            onModelRemoved(model);
            onModelAdd(model);
          }
        });
      }),
    );

    this._disposables.push({
      dispose: () => {
        Monaco.editor.getModels().forEach(onModelRemoved);
        for (let key in this._listener) {
          this._listener[key].dispose();
        }
      },
    });

    Monaco.editor.getModels().forEach(onModelAdd);
  }

  public dispose(): void {
    this._disposables.forEach((d) => d && d.dispose());
    this._disposables.length = 0;
  }

  private _doValidate(resource: monacoNS.Uri, languageId: string): void {
    this._worker(resource)
      .then((worker) => {
        return worker.doValidation(resource.toString());
      })
      .then((diagnostics) => {
        const markers = diagnostics.map((d) => toDiagnostics(resource, d));
        let model = Monaco.editor.getModel(resource);
        if (model && model.getLanguageId() === languageId) {
          Monaco.editor.setModelMarkers(model, languageId, markers);
        }
      })
      .then(undefined, (err) => {
        console.error(err);
      });
  }
}

function toSeverity(lsSeverity: number | undefined): monacoNS.MarkerSeverity {
  switch (lsSeverity) {
    case lsTypes.DiagnosticSeverity.Error:
      return Monaco.MarkerSeverity.Error;
    case lsTypes.DiagnosticSeverity.Warning:
      return Monaco.MarkerSeverity.Warning;
    case lsTypes.DiagnosticSeverity.Information:
      return Monaco.MarkerSeverity.Info;
    case lsTypes.DiagnosticSeverity.Hint:
      return Monaco.MarkerSeverity.Hint;
    default:
      return Monaco.MarkerSeverity.Info;
  }
}

function toDiagnostics(
  resource: monacoNS.Uri,
  diag: lsTypes.Diagnostic,
): monacoNS.editor.IMarkerData {
  let code = typeof diag.code === "number" ? String(diag.code) : <string> diag.code;

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
    position: lsTypes.Position,
  ): Promise<lsTypes.CompletionList | null>;
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
          if (entry.insertTextFormat === lsTypes.InsertTextFormat.Snippet) {
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

export function fromPosition(position: monacoNS.Position): lsTypes.Position;
export function fromPosition(position: undefined): undefined;
export function fromPosition(
  position: monacoNS.Position | undefined,
): lsTypes.Position | undefined;
export function fromPosition(
  position: monacoNS.Position | undefined,
): lsTypes.Position | undefined {
  if (!position) {
    return void 0;
  }
  return { character: position.column - 1, line: position.lineNumber - 1 };
}

export function fromRange(range: monacoNS.IRange): lsTypes.Range;
export function fromRange(range: undefined): undefined;
export function fromRange(range: monacoNS.IRange | undefined): lsTypes.Range | undefined;
export function fromRange(
  range: monacoNS.IRange | undefined,
): lsTypes.Range | undefined {
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
export function toRange(range: lsTypes.Range): monacoNS.Range;
export function toRange(range: undefined): undefined;
export function toRange(range: lsTypes.Range | undefined): monacoNS.Range | undefined;
export function toRange(range: lsTypes.Range | undefined): monacoNS.Range | undefined {
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
  edit: lsTypes.TextEdit | lsTypes.InsertReplaceEdit,
): edit is lsTypes.InsertReplaceEdit {
  return (
    typeof (<lsTypes.InsertReplaceEdit> edit).insert !== "undefined"
    && typeof (<lsTypes.InsertReplaceEdit> edit).replace !== "undefined"
  );
}

function toCompletionItemKind(
  kind: number | undefined,
): monacoNS.languages.CompletionItemKind {
  const mItemKind = Monaco.languages.CompletionItemKind;

  switch (kind) {
    case lsTypes.CompletionItemKind.Text:
      return mItemKind.Text;
    case lsTypes.CompletionItemKind.Method:
      return mItemKind.Method;
    case lsTypes.CompletionItemKind.Function:
      return mItemKind.Function;
    case lsTypes.CompletionItemKind.Constructor:
      return mItemKind.Constructor;
    case lsTypes.CompletionItemKind.Field:
      return mItemKind.Field;
    case lsTypes.CompletionItemKind.Variable:
      return mItemKind.Variable;
    case lsTypes.CompletionItemKind.Class:
      return mItemKind.Class;
    case lsTypes.CompletionItemKind.Interface:
      return mItemKind.Interface;
    case lsTypes.CompletionItemKind.Module:
      return mItemKind.Module;
    case lsTypes.CompletionItemKind.Property:
      return mItemKind.Property;
    case lsTypes.CompletionItemKind.Unit:
      return mItemKind.Unit;
    case lsTypes.CompletionItemKind.Value:
      return mItemKind.Value;
    case lsTypes.CompletionItemKind.Enum:
      return mItemKind.Enum;
    case lsTypes.CompletionItemKind.Keyword:
      return mItemKind.Keyword;
    case lsTypes.CompletionItemKind.Snippet:
      return mItemKind.Snippet;
    case lsTypes.CompletionItemKind.Color:
      return mItemKind.Color;
    case lsTypes.CompletionItemKind.File:
      return mItemKind.File;
    case lsTypes.CompletionItemKind.Reference:
      return mItemKind.Reference;
  }
  return mItemKind.Property;
}

export function toTextEdit(textEdit: lsTypes.TextEdit): monacoNS.languages.TextEdit;
export function toTextEdit(textEdit: undefined): undefined;
export function toTextEdit(
  textEdit: lsTypes.TextEdit | undefined,
): monacoNS.languages.TextEdit | undefined;
export function toTextEdit(
  textEdit: lsTypes.TextEdit | undefined,
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
  c: lsTypes.Command | undefined,
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
    position: lsTypes.Position,
  ): Promise<lsTypes.Hover | null>;
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

function isMarkupContent(thing: any): thing is lsTypes.MarkupContent {
  return (
    thing && typeof thing === "object"
    && typeof (<lsTypes.MarkupContent> thing).kind === "string"
  );
}

function toMarkdownString(
  entry: lsTypes.MarkupContent | lsTypes.MarkedString,
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
    | lsTypes.MarkupContent
    | lsTypes.MarkedString
    | lsTypes.MarkedString[],
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
    position: lsTypes.Position,
  ): Promise<lsTypes.DocumentHighlight[]>;
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
  kind: lsTypes.DocumentHighlightKind | undefined,
): monacoNS.languages.DocumentHighlightKind {
  switch (kind) {
    case lsTypes.DocumentHighlightKind.Read:
      return Monaco.languages.DocumentHighlightKind.Read;
    case lsTypes.DocumentHighlightKind.Write:
      return Monaco.languages.DocumentHighlightKind.Write;
    case lsTypes.DocumentHighlightKind.Text:
      return Monaco.languages.DocumentHighlightKind.Text;
  }
  return Monaco.languages.DocumentHighlightKind.Text;
}

// #endregion

// #region DefinitionAdapter

export interface ILanguageWorkerWithDefinitions {
  findDefinition(
    uri: string,
    position: lsTypes.Position,
  ): Promise<lsTypes.Location | null>;
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

function toLocation(location: lsTypes.Location): monacoNS.languages.Location {
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
    position: lsTypes.Position,
  ): Promise<lsTypes.Location[]>;
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
    position: lsTypes.Position,
    newName: string,
  ): Promise<lsTypes.WorkspaceEdit | null>;
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
  edit: lsTypes.WorkspaceEdit | null,
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
  ): Promise<lsTypes.SymbolInformation[] | lsTypes.DocumentSymbol[]>;
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

function isDocumentSymbol(
  symbol: lsTypes.SymbolInformation | lsTypes.DocumentSymbol,
): symbol is lsTypes.DocumentSymbol {
  return "children" in symbol;
}

function toDocumentSymbol(
  symbol: lsTypes.DocumentSymbol,
): monacoNS.languages.DocumentSymbol {
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

function toSymbolKind(kind: lsTypes.SymbolKind): monacoNS.languages.SymbolKind {
  let mKind = Monaco.languages.SymbolKind;

  switch (kind) {
    case lsTypes.SymbolKind.File:
      return mKind.File;
    case lsTypes.SymbolKind.Module:
      return mKind.Module;
    case lsTypes.SymbolKind.Namespace:
      return mKind.Namespace;
    case lsTypes.SymbolKind.Package:
      return mKind.Package;
    case lsTypes.SymbolKind.Class:
      return mKind.Class;
    case lsTypes.SymbolKind.Method:
      return mKind.Method;
    case lsTypes.SymbolKind.Property:
      return mKind.Property;
    case lsTypes.SymbolKind.Field:
      return mKind.Field;
    case lsTypes.SymbolKind.Constructor:
      return mKind.Constructor;
    case lsTypes.SymbolKind.Enum:
      return mKind.Enum;
    case lsTypes.SymbolKind.Interface:
      return mKind.Interface;
    case lsTypes.SymbolKind.Function:
      return mKind.Function;
    case lsTypes.SymbolKind.Variable:
      return mKind.Variable;
    case lsTypes.SymbolKind.Constant:
      return mKind.Constant;
    case lsTypes.SymbolKind.String:
      return mKind.String;
    case lsTypes.SymbolKind.Number:
      return mKind.Number;
    case lsTypes.SymbolKind.Boolean:
      return mKind.Boolean;
    case lsTypes.SymbolKind.Array:
      return mKind.Array;
  }
  return mKind.Function;
}

// #endregion

// #region DocumentLinkAdapter

export interface ILanguageWorkerWithDocumentLinks {
  findDocumentLinks(uri: string): Promise<lsTypes.DocumentLink[]>;
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
    range: lsTypes.Range | null,
    options: lsTypes.FormattingOptions,
  ): Promise<lsTypes.TextEdit[]>;
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

export class DocumentRangeFormattingEditProvider<
  T extends ILanguageWorkerWithFormat,
> implements monacoNS.languages.DocumentRangeFormattingEditProvider {
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

function fromFormattingOptions(
  options: monacoNS.languages.FormattingOptions,
): lsTypes.FormattingOptions {
  return {
    tabSize: options.tabSize,
    insertSpaces: options.insertSpaces,
  };
}

// #endregion

// #region DocumentColorAdapter

export interface ILanguageWorkerWithDocumentColors {
  findDocumentColors(uri: string): Promise<lsTypes.ColorInformation[]>;
  getColorPresentations(
    uri: string,
    color: lsTypes.Color,
    range: lsTypes.Range,
  ): Promise<lsTypes.ColorPresentation[]>;
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
  ): Promise<lsTypes.FoldingRange[]>;
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
              <lsTypes.FoldingRangeKind> range.kind,
            );
          }
          return result;
        });
      });
  }
}

function toFoldingRangeKind(
  kind: lsTypes.FoldingRangeKind,
): monacoNS.languages.FoldingRangeKind | undefined {
  switch (kind) {
    case lsTypes.FoldingRangeKind.Comment:
      return Monaco.languages.FoldingRangeKind.Comment;
    case lsTypes.FoldingRangeKind.Imports:
      return Monaco.languages.FoldingRangeKind.Imports;
    case lsTypes.FoldingRangeKind.Region:
      return Monaco.languages.FoldingRangeKind.Region;
  }
  return void 0;
}

// #endregion

// #region SelectionRangeAdapter

export interface ILanguageWorkerWithSelectionRanges {
  getSelectionRanges(
    uri: string,
    positions: lsTypes.Position[],
  ): Promise<lsTypes.SelectionRange[]>;
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
          positions.map<lsTypes.Position>(fromPosition),
        )
      )
      .then((selectionRanges) => {
        if (!selectionRanges) {
          return;
        }
        return selectionRanges.map(
          (selectionRange: lsTypes.SelectionRange | undefined) => {
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
