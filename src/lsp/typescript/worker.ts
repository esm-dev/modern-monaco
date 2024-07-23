/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Je Xia <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type monacoNS from "monaco-editor-core";
import type * as lst from "vscode-languageserver-types";
import {
  CompletionItemKind,
  CompletionItemTag,
  DiagnosticSeverity,
  DiagnosticTag,
  DocumentHighlightKind,
  FoldingRangeKind,
  Range,
  SelectionRange,
  SymbolKind,
  TextDocument,
} from "vscode-languageserver-types";
import ts from "typescript";

// ! external modules, don't remove the `.js` extension
import { cache } from "../../cache.js";
import { initializeWorker } from "../../editor-worker.js";
import { type ImportMap, isBlankImportMap, resolve } from "../../import-map.js";

export interface Host {
  openModel(uri: string): Promise<boolean>;
  refreshDiagnostics: () => Promise<void>;
}

export interface VersionedContent {
  content: string;
  version: number;
}

export interface CreateData {
  compilerOptions: ts.CompilerOptions;
  importMap: ImportMap;
  libs: Record<string, string>;
  types: Record<string, VersionedContent>;
  vfs?: string[];
  formatOptions?: ts.FormatCodeSettings & Pick<ts.UserPreferences, "quotePreference">;
}

/** TypeScriptWorker removes all but the `fileName` property to avoid serializing circular JSON structures. */
export interface DiagnosticRelatedInformation extends Omit<ts.DiagnosticRelatedInformation, "file"> {
  file: { fileName: string } | undefined;
}

/** May store more in future. For now, this will simply be `true` to indicate when a diagnostic is an unused-identifier diagnostic. */
export interface Diagnostic extends DiagnosticRelatedInformation {
  reportsUnnecessary?: {};
  reportsDeprecated?: {};
  source?: string;
  relatedInformation?: DiagnosticRelatedInformation[];
}

export class TypeScriptWorker implements ts.LanguageServiceHost {
  private _ctx: monacoNS.worker.IWorkerContext<Host>;
  private _compilerOptions: ts.CompilerOptions;
  private _importMap: ImportMap;
  private _importMapVersion: number;
  private _isBlankImportMap: boolean;
  private _libs: Record<string, string>;
  private _types: Record<string, VersionedContent>;
  private _jsxImportUrl: string;
  private _formatOptions?: CreateData["formatOptions"];
  private _languageService = ts.createLanguageService(this);
  private _httpRedirects = new Map<string, string>();
  private _httpLibs = new Map<string, string>();
  private _httpModules = new Map<string, string>();
  private _httpTsModules = new Map<string, string>();
  private _dtsMap = new Map<string, string>();
  private _redirectModules: [modelUrl: string, node: ts.Node, url: string][] = [];
  private _unknownModules = new Set<string>();
  private _naModules = new Set<string>();
  private _vfs: string[] = [];
  private _openPromises = new Map<string, Promise<void>>();
  private _fetchPromises = new Map<string, Promise<void>>();
  private _refreshDiagnosticsTimer: number | null = null;
  private _documentCache = new Map<string, [string, TextDocument]>();

  constructor(ctx: monacoNS.worker.IWorkerContext<Host>, createData: CreateData) {
    this._ctx = ctx;
    this._compilerOptions = createData.compilerOptions;
    this._importMap = createData.importMap;
    this._importMapVersion = 0;
    this._isBlankImportMap = isBlankImportMap(createData.importMap);
    this._libs = createData.libs;
    this._types = createData.types;
    this._formatOptions = createData.formatOptions;
    this._vfs = createData.vfs;
    this._updateJsxImportSource();
  }

  // #region language service host

  getCurrentDirectory(): string {
    return "/";
  }

  // getDirectories(directoryName: string): string[] {
  //   console.log("getDirectories", directoryName);
  //   return [];
  // }

  readDirectory(
    path: string,
    extensions?: readonly string[],
    exclude?: readonly string[],
    include?: readonly string[],
    depth?: number,
  ): string[] {
    if (path === "file:///node_modules/") {
      return Object.keys(this._importMap.imports).filter((key) => key !== "@jsxImportSource");
    }
    const entries = this._vfs.filter((file) => file.startsWith(path) && (!extensions || extensions.some((ext) => file.endsWith(ext))));
    return entries;
  }

  readFile(filename: string): string | undefined {
    return this._getScriptText(filename);
  }

  fileExists(filename: string): boolean {
    if (filename.startsWith("/node_modules/")) return false;
    return (
      filename in this._libs
      || `lib.${filename}.d.ts` in this._libs
      || filename in this._types
      || this._httpLibs.has(filename)
      || this._httpModules.has(filename)
      || this._httpTsModules.has(filename)
      || !!this._getModel(filename)
    );
  }

  getCompilationSettings(): ts.CompilerOptions {
    return this._compilerOptions;
  }

  getScriptFileNames(): string[] {
    const models = this._ctx.getMirrorModels();
    const types = Object.keys(this._types);
    const libs = Object.keys(this._libs);
    const filenames = new Array<string>(
      models.length + types.length + libs.length + this._httpLibs.size + this._httpModules.size + this._httpTsModules.size,
    );
    let i = 0;
    for (const model of models) {
      filenames[i++] = model.uri.toString();
    }
    for (const filename of types) {
      filenames[i++] = filename;
    }
    for (const filename of libs) {
      filenames[i++] = filename;
    }
    for (const [filename] of this._httpLibs) {
      filenames[i++] = filename;
    }
    for (const [filename] of this._httpModules) {
      filenames[i++] = filename;
    }
    for (const [filename] of this._httpTsModules) {
      filenames[i++] = filename;
    }
    return filenames;
  }

  getScriptVersion(fileName: string): string {
    if (fileName in this._types) {
      return String(this._types[fileName].version);
    }
    if (
      fileName in this._libs
      || fileName in this._types
      || this._httpLibs.has(fileName)
      || this._httpModules.has(fileName)
      || this._httpTsModules.has(fileName)
    ) {
      return "1"; // static/remote modules/types
    }
    const model = this._getModel(fileName);
    if (model) {
      // change on import map will affect all models
      return this._importMapVersion + "." + model.version;
    }
    // unknown file
    return "0";
  }

  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    const text = this._getScriptText(fileName);
    if (text) {
      return {
        getText: (start, end) => text.substring(start, end),
        getLength: () => text.length,
        // todo: support incremental parsing
        getChangeRange: (_old: ts.IScriptSnapshot) => undefined,
      };
    }
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string {
    switch (options.target) {
      case 0 /* ES3 */:
      case 1 /* ES5 */:
        return "lib.d.ts";
      case 2 /* ES2015 */:
        return "lib.es6.d.ts";
      case 3 /* ES2016 */:
      case 4 /* ES2017 */:
      case 5 /* ES2018 */:
      case 6 /* ES2019 */:
      case 7 /* ES2020 */:
      case 8 /* ES2021 */:
      case 9 /* ES2022 */:
      case 10 /* ES2023 */:
        return `lib.es${2013 + options.target}.full.d.ts`;
      case 99 /* ESNext */:
        return "lib.esnext.full.d.ts";
      default:
        return "lib.es6.d.ts";
    }
  }

  // getScriptKind(fileName: string): ts.ScriptKind {
  //   if (fileName in this._libs || fileName in this._types || this._httpLibs.has(fileName)) {
  //     return ts.ScriptKind.TS;
  //   }
  //   if (this._httpModules.has(fileName)) {
  //     return ts.ScriptKind.JS;
  //   }
  //   const { pathname } = new URL(fileName, "file:///");
  //   const basename = pathname.substring(pathname.lastIndexOf("/") + 1);
  //   const dotIndex = basename.lastIndexOf(".");
  //   if (dotIndex === -1) {
  //     return ts.ScriptKind.JS;
  //   }
  //   const ext = basename.substring(dotIndex + 1);
  //   switch (ext) {
  //     case "mts":
  //     case "ts":
  //       return ts.ScriptKind.TS;
  //     case "tsx":
  //       return ts.ScriptKind.TSX;
  //     case "mjs":
  //     case "js":
  //       return ts.ScriptKind.JS;
  //     case "jsx":
  //       return ts.ScriptKind.JSX;
  //     case "json":
  //       return ts.ScriptKind.JSON;
  //     default:
  //       return ts.ScriptKind.JS;
  //   }
  // }

  resolveModuleNameLiterals(
    moduleLiterals: readonly ts.StringLiteralLike[],
    containingFile: string,
    _redirectedReference: ts.ResolvedProjectReference | undefined,
    _options: ts.CompilerOptions,
    _containingSourceFile: ts.SourceFile,
    _reusedNames: readonly ts.StringLiteralLike[] | undefined,
  ): readonly ts.ResolvedModuleWithFailedLookupLocations[] {
    this._redirectModules = this._redirectModules.filter(([modelUrl]) => modelUrl !== containingFile);
    return moduleLiterals.map((literal): ts.ResolvedModuleWithFailedLookupLocations["resolvedModule"] => {
      let specifier = literal.text;
      let importMapResovled = false;
      if (!this._isBlankImportMap) {
        const url = resolve(this._importMap, specifier, containingFile);
        importMapResovled = url !== specifier;
        if (importMapResovled) {
          specifier = url;
        }
      }
      if (!importMapResovled && !isHttpUrl(specifier) && !isRelativePath(specifier)) {
        return undefined;
      }
      let moduleUrl: URL;
      try {
        moduleUrl = new URL(specifier, containingFile);
      } catch (error) {
        return undefined;
      }
      if (getScriptExtension(moduleUrl.pathname, null) === null) {
        const ext = getScriptExtension(containingFile, null);
        if (ext === ".d.ts" || ext === ".d.mts" || ext === ".d.cts") {
          // use the extension of the containing file which is a dts file
          // when the module name has no extension.
          moduleUrl.pathname += ext;
        }
      }
      if (this._httpModules.has(containingFile)) {
        // ignore dependencies of http modules
        return {
          resolvedFileName: moduleUrl.href,
          extension: ".js",
        };
      }
      if (moduleUrl.protocol === "file:") {
        const moduleHref = moduleUrl.href;
        if (this._naModules.has(moduleHref)) {
          return undefined;
        }
        for (const model of this._ctx.getMirrorModels()) {
          if (moduleHref === model.uri.toString()) {
            return {
              resolvedFileName: moduleHref,
              extension: getScriptExtension(moduleUrl.pathname),
            };
          }
        }
        if (!this._vfs) {
          return undefined;
        }
        if (!this._openPromises.has(moduleHref)) {
          this._openPromises.set(
            moduleHref,
            this._ctx.host.openModel(moduleHref).then((ok) => {
              if (!ok) {
                this._naModules.add(moduleHref);
                this._rollbackVersion(containingFile);
              }
            }).finally(() => {
              this._openPromises.delete(moduleHref);
              this._refreshDiagnostics();
            }),
          );
        }
      } else {
        const moduleHref = moduleUrl.href;
        if (this._naModules.has(moduleHref) || this._unknownModules.has(moduleHref)) {
          return undefined;
        }
        if (this._httpRedirects.has(moduleHref)) {
          const redirectUrl = this._httpRedirects.get(moduleHref);
          this._redirectModules.push([containingFile, literal, redirectUrl]);
        }
        if (this._httpModules.has(moduleHref)) {
          return {
            resolvedFileName: moduleHref,
            extension: getScriptExtension(moduleUrl.pathname, ".js"),
          };
        }
        if (this._httpTsModules.has(moduleHref)) {
          return {
            resolvedFileName: moduleHref,
            extension: getScriptExtension(moduleUrl.pathname, ".ts"),
          };
        }
        if (this._dtsMap.has(moduleHref)) {
          return {
            resolvedFileName: this._dtsMap.get(moduleHref),
            extension: ".d.ts",
          };
        }
        if (this._httpLibs.has(moduleHref)) {
          return {
            resolvedFileName: moduleHref,
            extension: ".d.ts",
          };
        }
        if (!this._fetchPromises.has(moduleHref)) {
          const autoFetch = specifier === this._jsxImportUrl || importMapResovled || isHttpUrl(containingFile) || isEsmshModule(moduleUrl);
          const promise = autoFetch ? cache.fetch(moduleUrl) : cache.query(moduleUrl);
          this._fetchPromises.set(
            moduleHref,
            promise.then(async (res) => {
              if (!res) {
                // did not find the module in the cache
                this._unknownModules.add(moduleHref);
                this._rollbackVersion(containingFile);
                return;
              }
              if (res.ok) {
                const contentType = res.headers.get("content-type");
                const dts = res.headers.get("x-typescript-types");
                const resUrl = new URL(res.url);
                if (res.redirected) {
                  this._httpRedirects.set(moduleHref, resUrl.href);
                }
                if (dts) {
                  res.body?.cancel();
                  const dtsRes = await cache.fetch(new URL(dts, res.url));
                  if (dtsRes.ok) {
                    this._httpLibs.set(dtsRes.url, await dtsRes.text());
                    this._dtsMap.set(moduleHref, dtsRes.url);
                  }
                } else if (
                  /\.(c|m)?jsx?$/.test(resUrl.pathname)
                  || /^(application|text)\/(javascript|jsx)/.test(contentType)
                ) {
                  this._httpModules.set(moduleHref, await res.text());
                } else if (
                  /\.(c|m)?tsx?$/.test(resUrl.pathname)
                  || /^(application|text)\/(typescript|tsx)/.test(contentType)
                ) {
                  if (/\.d\.(c|m)?ts$/.test(resUrl.pathname)) {
                    this._httpLibs.set(moduleHref, await res.text());
                  } else {
                    this._httpTsModules.set(moduleHref, await res.text());
                  }
                } else {
                  // not a javascript or typescript module
                  res.body?.cancel();
                  this._naModules.add(moduleHref);
                }
              } else {
                // bad response
                res.body?.cancel();
                this._naModules.add(moduleHref);
              }
              this._rollbackVersion(containingFile);
            }).finally(() => {
              this._fetchPromises.delete(moduleHref);
              this._refreshDiagnostics();
            }),
          );
        }
      }
      // resolving modules...
      return { resolvedFileName: specifier, extension: ".js" };
    }).map((resolvedModule) => {
      return { resolvedModule };
    });
  }

  // #endregion

  // #region language features

  async doValidation(uri: string): Promise<lst.Diagnostic[] | null> {
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }
    const languageId = document.languageId;
    const diagnostics: lst.Diagnostic[] = [];
    for (const diagnostic of this._languageService.getSyntacticDiagnostics(uri)) {
      diagnostics.push(this._convertDiagnostic(document, diagnostic));
    }
    for (const diagnostic of this._languageService.getSuggestionDiagnostics(uri)) {
      diagnostics.push(this._convertDiagnostic(document, diagnostic));
    }
    if (languageId === "typescript" || languageId === "tsx") {
      for (const diagnostic of this._languageService.getSemanticDiagnostics(uri)) {
        diagnostics.push(this._convertDiagnostic(document, diagnostic));
      }
    }
    if (this._redirectModules.length > 0) {
      this._redirectModules.forEach(([modelUrl, node, url]) => {
        if (modelUrl === uri) {
          diagnostics.push(this._convertDiagnostic(document, {
            file: null,
            start: node.getStart(),
            length: node.getWidth(),
            code: 7000,
            category: ts.DiagnosticCategory.Message,
            messageText: `The module was redirected to ${url}`,
          }));
        }
      });
    }
    return diagnostics;
  }

  async doComplete(uri: string, position: lst.Position): Promise<lst.CompletionList | null> {
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }
    const offset = document.offsetAt(position);
    const completions = this._getCompletionsAtPosition(uri, offset);
    if (!completions) {
      return { isIncomplete: false, items: [] };
    }
    const items: lst.CompletionItem[] = [];
    for (const entry of completions.entries) {
      // drop import completions that are in the import map for '.' and '..' imports
      if (entry.kind === "script" && entry.name in this._importMap.imports || entry.name + "/" in this._importMap.imports) {
        const { replacementSpan } = entry;
        if (replacementSpan?.length > 0) {
          const replacementText = document.getText({
            start: document.positionAt(replacementSpan.start),
            end: document.positionAt(replacementSpan.start + replacementSpan.length),
          });
          if (replacementText.startsWith(".")) {
            continue;
          }
        }
      }
      // data used for resolving item details (see 'doResolveCompletionItem')
      const data = { entryData: entry.data, context: { uri, offset, languageId: document.languageId } };
      const tags: lst.CompletionItemTag[] = [];
      if (entry.kindModifiers?.includes("deprecated")) {
        tags.push(CompletionItemTag.Deprecated);
      }
      items.push({
        label: entry.name,
        insertText: entry.name,
        filterText: entry.filterText,
        sortText: entry.sortText,
        kind: toCompletionItemKind(entry.kind),
        tags,
        data,
      });
    }
    return {
      isIncomplete: completions.isIncomplete,
      items: items,
    };
  }

  async doResolveCompletionItem(item: lst.CompletionItem): Promise<lst.CompletionItem | null> {
    if (!item.data?.context) {
      return null;
    }
    const { uri, offset } = item.data.context;
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }
    const details = this._getCompletionEntryDetails(uri, offset, item.label, item.data.entryData);
    if (!details) {
      return null;
    }
    const detail = ts.displayPartsToString(details.displayParts);
    const documentation = ts.displayPartsToString(details.documentation);
    const additionalTextEdits: lst.TextEdit[] = [];
    if (details.codeActions) {
      details.codeActions.forEach((action) =>
        action.changes.forEach((change) =>
          change.textChanges.forEach(({ span, newText }) => {
            additionalTextEdits.push({
              range: convertRange(document, span),
              newText,
            });
          })
        )
      );
    }
    return { label: item.label, detail, documentation, additionalTextEdits };
  }

  async doHover(uri: string, position: lst.Position): Promise<lst.Hover | null> {
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }

    const info = this._getQuickInfoAtPosition(uri, document.offsetAt(position));
    if (info) {
      const contents = ts.displayPartsToString(info.displayParts);
      const documentation = ts.displayPartsToString(info.documentation);
      const tags = info.tags?.map((tag) => tagToString(tag)).join("  \n\n") ?? null;
      return {
        range: convertRange(document, info.textSpan),
        contents: [
          { language: "typescript", value: contents },
          documentation + (tags ? "\n\n" + tags : ""),
        ],
      };
    }
    return null;
  }

  async doSignatureHelp(
    uri: string,
    position: number,
    context: monacoNS.languages.SignatureHelpContext,
  ): Promise<lst.SignatureHelp | null> {
    const triggerReason = toSignatureHelpTriggerReason(context);
    const items = this._languageService.getSignatureHelpItems(uri, position, { triggerReason });
    if (!items) {
      return null;
    }

    const activeSignature = items.selectedItemIndex;
    const activeParameter = items.argumentIndex;
    const signatures = items.items.map(item => {
      const signature: lst.SignatureInformation = { label: "", parameters: [] };
      signature.documentation = ts.displayPartsToString(item.documentation);
      signature.label += ts.displayPartsToString(item.prefixDisplayParts);
      item.parameters.forEach((p, i, a) => {
        const label = ts.displayPartsToString(p.displayParts);
        const parameter: lst.ParameterInformation = {
          label: label,
          documentation: ts.displayPartsToString(p.documentation),
        };
        signature.label += label;
        signature.parameters.push(parameter);
        if (i < a.length - 1) {
          signature.label += ts.displayPartsToString(item.separatorDisplayParts);
        }
      });
      signature.label += ts.displayPartsToString(item.suffixDisplayParts);
      return signature;
    });
    return { signatures, activeSignature, activeParameter };
  }

  async doCodeAction(
    uri: string,
    range: lst.Range,
    context: lst.CodeActionContext,
    formatOptions: lst.FormattingOptions,
  ): Promise<lst.CodeAction[] | null> {
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    const errorCodes = context.diagnostics.map(diagnostic => diagnostic.code).filter(Boolean).map(Number);
    const codeFixes = await this._getCodeFixesAtPosition(uri, start, end, errorCodes, toTsFormatOptions(formatOptions));
    return codeFixes.map(codeFix => {
      const action: lst.CodeAction = {
        title: codeFix.description,
        kind: "quickfix",
      };
      if (codeFix.changes.length > 0) {
        const edits: lst.TextEdit[] = [];
        for (const change of codeFix.changes) {
          for (const { span, newText } of change.textChanges) {
            edits.push({ range: convertRange(document, span), newText });
          }
        }
        action.edit = { changes: { [uri]: edits } };
      }
      if (codeFix.commands?.length > 0) {
        const command: any = codeFix.commands[0];
        action.command = {
          title: command.title,
          command: command.id,
          arguments: command.arguments,
        };
      }
      return action;
    });
  }

  async doRename(uri: string, position: lst.Position, newName: string): Promise<lst.WorkspaceEdit | null> {
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }

    const documentPosition = document.offsetAt(position);
    const locations = this._languageService.findRenameLocations(uri, documentPosition, false, false, {});
    const edits: lst.TextEdit[] = [];
    locations?.map(loc => {
      if (loc.fileName === uri) {
        edits.push({
          range: convertRange(document, loc.textSpan),
          newText: newName,
        });
      }
    });
    return { changes: { [uri]: edits } };
  }

  async doFormat(
    uri: string,
    range: lst.Range | null,
    formatOptions: lst.FormattingOptions,
    docText?: string,
  ): Promise<lst.TextEdit[] | null> {
    const document = docText ? TextDocument.create(uri, "typescript", 0, docText) : this._getScriptDocument(uri);
    if (!document) {
      return null;
    }
    const formattingOptions = this._mergeFormatOptions(toTsFormatOptions(formatOptions));
    let edits: ts.TextChange[];
    if (range) {
      const start = document.offsetAt(range.start);
      const end = document.offsetAt(range.end);
      edits = this._languageService.getFormattingEditsForRange(uri, start, end, formattingOptions);
    } else {
      edits = this._languageService.getFormattingEditsForDocument(uri, formattingOptions);
    }
    return edits.map(({ span, newText }) => ({
      range: convertRange(document, span),
      newText,
    }));
  }

  async doAutoInsert(uri: string, position: lst.Position, ch: string): Promise<string | null> {
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }
    const info = this._languageService.getJsxClosingTagAtPosition(uri, document.offsetAt(position));
    if (info) {
      return "$0" + info.newText;
    }
    return null;
  }

  async findDocumentSymbols(uri: string): Promise<lst.DocumentSymbol[] | null> {
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }
    const toSymbol = (item: ts.NavigationTree, containerLabel?: string): lst.DocumentSymbol => {
      const result: lst.DocumentSymbol = {
        name: item.text,
        kind: toSymbolKind(item.kind),
        range: convertRange(document, item.spans[0]),
        selectionRange: convertRange(document, item.spans[0]),
        children: item.childItems?.map((child) => toSymbol(child, item.text)),
      };
      if (containerLabel) {
        Reflect.set(result, "containerName", containerLabel);
      }
      return result;
    };
    const root = this._languageService.getNavigationTree(uri);
    return root.childItems?.map((item) => toSymbol(item)) ?? null;
  }

  async findDefinition(
    uri: string,
    position: lst.Position,
  ): Promise<(lst.Location & { originSelectionRange: lst.Range })[] | null> {
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }
    const res = this._languageService.getDefinitionAndBoundSpan(uri, document.offsetAt(position));
    if (res) {
      const { definitions, textSpan } = res;
      return definitions.map(d => {
        const doc = d.fileName === uri ? document : this._getScriptDocument(d.fileName);
        if (doc) {
          return {
            uri: d.fileName,
            range: convertRange(doc, d.textSpan),
            originSelectionRange: convertRange(document, textSpan),
          };
        }
      }).filter(Boolean);
    }
    return null;
  }

  async findReferences(uri: string, position: lst.Position): Promise<lst.Location[] | null> {
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }
    const references = this._languageService.getReferencesAtPosition(uri, document.offsetAt(position));
    const result: lst.Location[] = [];
    for (let entry of references) {
      const entryDocument = this._getScriptDocument(entry.fileName);
      if (entryDocument) {
        result.push({
          uri: entryDocument.uri,
          range: convertRange(entryDocument, entry.textSpan),
        });
      }
    }
    return result;
  }

  async findDocumentHighlights(uri: string, position: lst.Position): Promise<lst.DocumentHighlight[] | null> {
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }
    const highlights = this._languageService.getDocumentHighlights(uri, document.offsetAt(position), [uri]);
    const out: lst.DocumentHighlight[] = [];
    for (const entry of highlights || []) {
      for (const highlight of entry.highlightSpans) {
        out.push({
          range: convertRange(document, highlight.textSpan),
          kind: highlight.kind === "writtenReference" ? DocumentHighlightKind.Write : DocumentHighlightKind.Text,
        });
      }
    }
    return out;
  }

  async getFoldingRanges(uri: string): Promise<lst.FoldingRange[] | null> {
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }
    const spans = this._languageService.getOutliningSpans(uri);
    const ranges: lst.FoldingRange[] = [];
    for (const span of spans) {
      const curr = convertRange(document, span.textSpan);
      const startLine = curr.start.line;
      const endLine = curr.end.line;
      if (startLine < endLine) {
        const foldingRange: lst.FoldingRange = { startLine, endLine };
        const match = document.getText(curr).match(/^\s*\/(?:(\/\s*#(?:end)?region\b)|(\*|\/))/);
        if (match) {
          foldingRange.kind = match[1] ? FoldingRangeKind.Region : FoldingRangeKind.Comment;
        }
        ranges.push(foldingRange);
      }
    }
    return ranges;
  }

  async getSelectionRanges(uri: string, positions: lst.Position[]): Promise<lst.SelectionRange[] | null> {
    const document = this._getScriptDocument(uri);
    if (!document) {
      return null;
    }
    function convertSelectionRange(selectionRange: ts.SelectionRange): lst.SelectionRange {
      const parent = selectionRange.parent ? convertSelectionRange(selectionRange.parent) : undefined;
      return SelectionRange.create(convertRange(document, selectionRange.textSpan), parent);
    }
    return positions.map(position => {
      const range = this._languageService.getSmartSelectionRange(uri, document.offsetAt(position));
      return convertSelectionRange(range);
    });
  }

  // #endregion

  // #region public methods used by the host

  async fetchHttpModule(specifier: string, containingFile: string): Promise<void> {
    if (this._unknownModules.has(specifier)) {
      const res = await cache.fetch(specifier);
      res.body?.cancel();
      this._unknownModules.delete(specifier);
      if (!res.ok) {
        this._naModules.add(specifier);
      }
      this._rollbackVersion(containingFile);
      this._refreshDiagnostics();
    }
  }

  async updateCompilerOptions(options: {
    compilerOptions?: ts.CompilerOptions;
    importMap?: ImportMap;
    types?: Record<string, VersionedContent>;
  }): Promise<void> {
    const { compilerOptions, importMap, types } = options;
    if (compilerOptions) {
      this._compilerOptions = compilerOptions;
      this._updateJsxImportSource();
    }
    if (importMap) {
      this._importMap = importMap;
      this._importMapVersion++;
      this._isBlankImportMap = isBlankImportMap(importMap);
      this._updateJsxImportSource();
    }
    if (types) {
      for (const uri of Object.keys(this._types)) {
        this._documentCache.delete(uri);
      }
      this._types = types;
    }
  }

  async onDocumentRemoved(uri: string): Promise<void> {
    this._documentCache.delete(uri);
  }

  async updateVFS(evt: { kind: "create" | "remove"; path: string }): Promise<void> {
    const { kind, path } = evt;
    const url = new URL(path, "file:///").href;
    if (kind === "create") {
      this._vfs.push(url);
    } else {
      const index = this._vfs.indexOf(url);
      if (index !== -1) {
        this._vfs.splice(index, 1);
      }
    }
  }

  // #endregion

  // #region private methods

  private _getCompletionsAtPosition(fileName: string, position: number): ts.CompletionInfo | undefined {
    const completions = this._languageService.getCompletionsAtPosition(
      fileName,
      position,
      {
        quotePreference: this._formatOptions?.quotePreference,
        allowRenameOfImportPath: true,
        importModuleSpecifierEnding: "js",
        importModuleSpecifierPreference: "shortest",
        includeCompletionsForModuleExports: true,
        includeCompletionsForImportStatements: true,
        includePackageJsonAutoImports: "off",
        organizeImportsIgnoreCase: false,
      },
    );
    // filter repeated auto-import suggestions from a types module
    if (completions) {
      const autoImports = new Set<string>();
      completions.entries = completions.entries.filter((entry) => {
        const { data } = entry;
        if (!data || !isDts(data.fileName)) {
          return true;
        }
        if (data.moduleSpecifier in this._importMap.imports || this._dtsMap.has(data.moduleSpecifier)) {
          autoImports.add(data.exportName + " " + data.moduleSpecifier);
          return true;
        }
        const specifier = this._getSpecifierFromDts(data.fileName);
        if (specifier && !autoImports.has(data.exportName + " " + specifier)) {
          autoImports.add(data.exportName + " " + specifier);
          return true;
        }
        return false;
      });
      return completions;
    }
    return undefined;
  }

  private _getCompletionEntryDetails(
    fileName: string,
    position: number,
    entryName: string,
    data?: ts.CompletionEntryData,
  ): ts.CompletionEntryDetails | undefined {
    try {
      const detail = this._languageService.getCompletionEntryDetails(
        fileName,
        position,
        entryName,
        {
          insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: true,
          semicolons: ts.SemicolonPreference.Insert,
        },
        undefined,
        undefined,
        data,
      );
      // fix the url of auto import suggestions from a types module
      detail?.codeActions?.forEach((action) => {
        if (action.description.startsWith("Add import from ")) {
          const specifier = action.description.slice(17, -1);
          const newSpecifier = this._getSpecifierFromDts(
            isDts(specifier) ? specifier : specifier + ".d.ts",
          );
          if (newSpecifier) {
            action.description = `Add type import from "${newSpecifier}"`;
            action.changes.forEach((change) => {
              change.textChanges.forEach((textChange) => {
                textChange.newText = textChange.newText.replace(
                  specifier,
                  newSpecifier,
                );
              });
            });
          }
        }
      });
      return detail;
    } catch (error) {
      return;
    }
  }

  private _getQuickInfoAtPosition(fileName: string, position: number): ts.QuickInfo | undefined {
    const info = this._languageService.getQuickInfoAtPosition(fileName, position);
    if (!info) {
      return;
    }

    // pettier display for module specifiers
    const { kind, kindModifiers, displayParts, textSpan } = info;
    if (kind === ts.ScriptElementKind.moduleElement && displayParts?.length === 3) {
      const moduleName = displayParts[2].text;
      // show pathname for `file:` specifiers
      if (moduleName.startsWith("\"file:") && fileName.startsWith("file:")) {
        const model = this._getModel(fileName);
        const literalText = model.getValue().substring(
          textSpan.start,
          textSpan.start + textSpan.length,
        );
        const specifier = JSON.parse(literalText);
        info.displayParts[2].text = "\"" + new URL(specifier, fileName).pathname + "\"";
      } else if (
        // show module url for `http:` specifiers instead of the types url
        kindModifiers === "declare" && moduleName.startsWith("\"http")
      ) {
        const specifier = JSON.parse(moduleName);
        for (const [url, dts] of this._dtsMap) {
          if (specifier + ".d.ts" === dts) {
            info.displayParts[2].text = "\"" + url + "\"";
            info.tags = [{
              name: "types",
              text: [{ kind: "text", text: dts }],
            }];
            if (/^https:\/\/esm\.sh\//.test(url)) {
              const { pathname } = new URL(url);
              const pathSegments = pathname.split("/").slice(1);
              if (/^v\d$/.test(pathSegments[0])) {
                pathSegments.shift();
              }
              let scope = "";
              let pkgName = pathSegments.shift();
              if (pkgName?.startsWith("@")) {
                scope = pkgName;
                pkgName = pathSegments.shift();
              }
              if (!pkgName) {
                continue;
              }
              const npmPkgId = [scope, pkgName.split("@")[0]].filter(Boolean).join("/");
              const npmPkgUrl = `https://www.npmjs.com/package/${npmPkgId}`;
              info.tags.unshift({
                name: "npm",
                text: [{ kind: "text", text: `[${npmPkgId}](${npmPkgUrl})` }],
              });
            }
            break;
          }
        }
      }
    }
    return info;
  }

  private async _getCodeFixesAtPosition(
    fileName: string,
    start: number,
    end: number,
    errorCodes: number[],
    formatOptions: ts.FormatCodeSettings,
  ): Promise<ts.CodeFixAction[]> {
    let span = [start + 1, end - 1] as [number, number];
    // fix url/path span
    if (start === end && (this._redirectModules.length > 0 || errorCodes.includes(2307))) {
      const a = this._languageService.getReferencesAtPosition(fileName, start);
      if (a && a.length > 0) {
        const b = a[0];
        span = [b.textSpan.start, b.textSpan.start + b.textSpan.length];
      }
    }
    const fixes: ts.CodeFixAction[] = [];
    if (this._redirectModules.length > 0) {
      const i = this._redirectModules.findIndex(([modelUrl, node]) => {
        return fileName === modelUrl && node.getStart() === span[0] - 1 && node.getEnd() === span[1] + 1;
      });
      if (i >= 0) {
        const [_, node, url] = this._redirectModules[i];
        const fixName = `Update module specifier to ${url}`;
        fixes.push({
          fixName,
          description: fixName,
          changes: [{
            fileName,
            textChanges: [{
              span: { start: node.getStart(), length: node.getWidth() },
              newText: JSON.stringify(url),
            }],
          }],
        });
      }
    }
    if (errorCodes.includes(2307)) {
      const model = this._getModel(fileName);
      const specifier = model.getValue().slice(...span);
      const importMapSrc = this._importMap.$src;
      if (this._unknownModules.has(specifier)) {
        const fixName = `Fetch module from '${specifier}'`;
        fixes.push({
          fixName,
          description: fixName,
          changes: [],
          commands: [{
            id: "ts:fetch_http_module",
            title: "Fetch the module from internet",
            arguments: [specifier, fileName],
          }],
        });
      }
      // else if (/^@?\w[\w\.\-]*(\/|$)/.test(specifier) && importMapSrc) {
      //   const fixName = `Lookup module '${specifier}' on https://esm.sh`;
      //   fixes.push({
      //     fixName,
      //     description: fixName,
      //     changes: [],
      //     commands: [{
      //       id: "lookup-module",
      //       title: "Lookup module on https://esm.sh",
      //       arguments: [importMapSrc, specifier],
      //     }],
      //   });
      // }
    }
    try {
      const tsFixes = this._languageService.getCodeFixesAtPosition(
        fileName,
        start,
        end,
        errorCodes,
        this._mergeFormatOptions(formatOptions),
        {},
      );
      return fixes.concat(tsFixes);
    } catch (err) {
      return fixes;
    }
  }

  /** notifies the host to refresh diagnostics. */
  private _refreshDiagnostics(): void {
    if (this._refreshDiagnosticsTimer !== null) {
      clearTimeout(this._refreshDiagnosticsTimer);
    }
    this._refreshDiagnosticsTimer = setTimeout(() => {
      this._refreshDiagnosticsTimer = null;
      this._ctx.host.refreshDiagnostics();
    }, 150);
  }

  /** rollback the version to force reinvoke `resolveModuleNameLiterals` method. */
  private _rollbackVersion(fileName: string) {
    const model = this._getModel(fileName);
    if (model) {
      // @ts-expect-error private field
      model._versionId--;
    }
  }

  private _getScriptText(fileName: string): string | undefined {
    return this._libs[fileName]
      ?? this._libs[`lib.${fileName}.d.ts`]
      ?? this._types[fileName]?.content
      ?? this._httpLibs.get(fileName)
      ?? this._httpModules.get(fileName)
      ?? this._httpTsModules.get(fileName)
      ?? this._getModel(fileName)?.getValue();
  }

  private _getScriptDocument(uri: string): TextDocument | null {
    const version = this.getScriptVersion(uri);
    const cached = this._documentCache.get(uri);
    if (cached && cached[0] === version) {
      return cached[1];
    }
    const scriptText = this._getScriptText(uri);
    if (scriptText) {
      const document = TextDocument.create(uri, "typescript", 0, scriptText);
      this._documentCache.set(uri, [version, document]);
      return document;
    }
    return null;
  }

  private _getModel(fileName: string): monacoNS.worker.IMirrorModel | null {
    const models = this._ctx.getMirrorModels();
    for (let i = 0; i < models.length; i++) {
      const uri = models[i].uri;
      if (uri.toString() === fileName || uri.toString(true) === fileName) {
        return models[i];
      }
    }
    return null;
  }

  private _getSpecifierFromDts(filename: string): string | void {
    for (const [specifier, dts] of this._dtsMap) {
      if (filename === dts) {
        if (!this._isBlankImportMap) {
          for (const [key, value] of Object.entries(this._importMap.imports)) {
            if (value === specifier && key !== "@jsxImportSource") {
              return key;
            }
          }
        }
        return specifier;
      }
    }
  }

  private _convertDiagnostic(document: TextDocument, diagnostic: ts.Diagnostic): lst.Diagnostic {
    const tags: lst.DiagnosticTag[] = [];
    if (diagnostic.reportsUnnecessary) {
      tags.push(DiagnosticTag.Unnecessary);
    }
    if (diagnostic.reportsDeprecated) {
      tags.push(DiagnosticTag.Deprecated);
    }
    return {
      range: convertRange(document, diagnostic),
      code: diagnostic.code,
      severity: tsDiagnosticCategoryToMarkerSeverity(diagnostic.category),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      source: diagnostic.source,
      tags,
      relatedInformation: this._convertRelatedInformation(document, diagnostic.relatedInformation),
    };
  }

  private _convertRelatedInformation(
    document: TextDocument,
    relatedInformation?: ts.DiagnosticRelatedInformation[],
  ): lst.DiagnosticRelatedInformation[] {
    if (!relatedInformation) {
      return [];
    }

    const result: lst.DiagnosticRelatedInformation[] = [];
    relatedInformation.forEach((info) => {
      const doc = info.file ? this._getScriptDocument(info.file.fileName) : document;
      if (!doc) {
        return;
      }

      const start = doc.positionAt(info.start ?? 0);
      const end = doc.positionAt((info.start ?? 0) + (info.length ?? 1));
      result.push({
        location: {
          uri: info.file.fileName,
          range: Range.create(start, end),
        },
        message: ts.flattenDiagnosticMessageText(info.messageText, "\n"),
      });
    });
    return result;
  }

  private _mergeFormatOptions(formatOptions: ts.FormatCodeSettings): ts.FormatCodeSettings {
    return { ...this._formatOptions, ...formatOptions };
  }

  private _updateJsxImportSource(): void {
    const compilerOptions = this._compilerOptions;
    if (!compilerOptions.jsxImportSource) {
      const jsxImportSource = this._importMap.imports["@jsxImportSource"];
      if (jsxImportSource) {
        compilerOptions.jsxImportSource = jsxImportSource;
        if (!compilerOptions.jsx) {
          compilerOptions.jsx = ts.JsxEmit.ReactJSX;
        }
      }
    }

    let runtimePath = "/jsx-runtime";
    if (this._compilerOptions.jsx === ts.JsxEmit.ReactJSXDev) {
      runtimePath = "/jsx-dev-runtime";
    }
    if (this._compilerOptions.jsxImportSource) {
      const url = new URL(this._compilerOptions.jsxImportSource + runtimePath);
      this._jsxImportUrl = url.toString();
    }
  }

  // #endregion
}

function getScriptExtension(url: URL | string, defaultExt = ".js"): string | null {
  const pathname = typeof url === "string" ? new URL(url, "file:///").pathname : url.pathname;
  const basename = pathname.substring(pathname.lastIndexOf("/") + 1);
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex === -1) {
    return defaultExt ?? null;
  }
  const ext = basename.substring(dotIndex + 1);
  switch (ext) {
    case "ts":
      return basename.endsWith(".d.ts") ? ".d.ts" : ".ts";
    case "mts":
      return basename.endsWith(".d.mts") ? ".d.mts" : ".mts";
    case "cts":
      return basename.endsWith(".d.cts") ? ".d.cts" : ".cts";
    case "tsx":
      return ".tsx";
    case "js":
      return ".js";
    case "mjs":
      return ".js";
    case "cjs":
      return ".cjs";
    case "jsx":
      return ".jsx";
    case "json":
      return ".json";
    default:
      return ".js";
  }
}

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function isRelativePath(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../");
}

function isEsmshModule(url: URL): boolean {
  const { hostname, pathname } = url;
  const isEsmshHost = hostname === "esm.sh" || hostname.endsWith(".esm.sh");
  return isEsmshHost
    && /\/(jsr\/)?((@|gh\/)[\w\.\-]+\/)?[\w\.\-]+@(\d+(\.\d+){0,2}(\-[\w\.]+)?|next|canary|rc|beta|latest)$/.test(pathname);
}

function isDts(fileName: string): boolean {
  return fileName.endsWith(".d.ts") || fileName.endsWith(".d.mts") || fileName.endsWith(".d.cts");
}

function convertRange(document: TextDocument, span: { start?: number; length?: number }): lst.Range {
  if (typeof span.start === "undefined") {
    const pos = document.positionAt(0);
    return Range.create(pos, pos);
  }
  const start = document.positionAt(span.start);
  const end = document.positionAt(span.start + (span.length || 0));
  return Range.create(start, end);
}

function toCompletionItemKind(kind: ts.ScriptElementKind): lst.CompletionItemKind {
  const Kind = ts.ScriptElementKind;

  switch (kind) {
    case Kind.primitiveType:
    case Kind.keyword:
      return CompletionItemKind.Keyword;

    case Kind.constElement:
    case Kind.letElement:
    case Kind.variableElement:
    case Kind.localVariableElement:
    case Kind.alias:
    case Kind.parameterElement:
      return CompletionItemKind.Variable;

    case Kind.memberVariableElement:
    case Kind.memberGetAccessorElement:
    case Kind.memberSetAccessorElement:
      return CompletionItemKind.Field;

    case Kind.functionElement:
    case Kind.localFunctionElement:
      return CompletionItemKind.Function;

    case Kind.memberFunctionElement:
    case Kind.constructSignatureElement:
    case Kind.callSignatureElement:
    case Kind.indexSignatureElement:
      return CompletionItemKind.Method;

    case Kind.enumElement:
      return CompletionItemKind.Enum;

    case Kind.enumMemberElement:
      return CompletionItemKind.EnumMember;

    case Kind.moduleElement:
    case Kind.externalModuleName:
      return CompletionItemKind.Module;

    case Kind.classElement:
    case Kind.typeElement:
      return CompletionItemKind.Class;

    case Kind.interfaceElement:
      return CompletionItemKind.Interface;

    case Kind.warning:
      return CompletionItemKind.Text;

    case Kind.scriptElement:
      return CompletionItemKind.File;

    case Kind.directory:
      return CompletionItemKind.Folder;

    case Kind.string:
      return CompletionItemKind.Constant;

    default:
      return CompletionItemKind.Property;
  }
}

function toSymbolKind(kind: ts.ScriptElementKind): lst.SymbolKind {
  const Kind = ts.ScriptElementKind;

  switch (kind) {
    case Kind.memberVariableElement:
    case Kind.memberGetAccessorElement:
    case Kind.memberSetAccessorElement:
      return SymbolKind.Field;

    case Kind.functionElement:
    case Kind.localFunctionElement:
      return SymbolKind.Function;

    case Kind.memberFunctionElement:
    case Kind.constructSignatureElement:
    case Kind.callSignatureElement:
    case Kind.indexSignatureElement:
      return SymbolKind.Method;

    case Kind.enumElement:
      return SymbolKind.Enum;

    case Kind.enumMemberElement:
      return SymbolKind.EnumMember;

    case Kind.moduleElement:
    case Kind.externalModuleName:
      return SymbolKind.Module;

    case Kind.classElement:
    case Kind.typeElement:
      return SymbolKind.Class;

    case Kind.interfaceElement:
      return SymbolKind.Interface;

    case Kind.scriptElement:
      return SymbolKind.File;

    case Kind.string:
      return SymbolKind.Constant;

    default:
      return SymbolKind.Variable;
  }
}

function tsDiagnosticCategoryToMarkerSeverity(category: ts.DiagnosticCategory): lst.DiagnosticSeverity {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return DiagnosticSeverity.Error;
    case ts.DiagnosticCategory.Message:
      return DiagnosticSeverity.Information;
    case ts.DiagnosticCategory.Warning:
      return DiagnosticSeverity.Warning;
    case ts.DiagnosticCategory.Suggestion:
      return DiagnosticSeverity.Hint;
  }
  return DiagnosticSeverity.Information;
}

function tagToString(tag: ts.JSDocTagInfo): string {
  let tagLabel = `*@${tag.name}*`;
  if (tag.name === "param" && tag.text) {
    const [paramName, ...rest] = tag.text;
    tagLabel += `\`${paramName.text}\``;
    if (rest.length > 0) tagLabel += ` — ${rest.map((r) => r.text).join(" ")}`;
  } else if (Array.isArray(tag.text)) {
    tagLabel += ` — ${tag.text.map((r) => r.text).join("")}`;
  } else if (tag.text) {
    tagLabel += ` — ${tag.text}`;
  }
  return tagLabel;
}

function toSignatureHelpTriggerReason(context: monacoNS.languages.SignatureHelpContext): ts.SignatureHelpTriggerReason {
  switch (context.triggerKind) {
    // SignatureHelpTriggerKind.TriggerCharacter
    case 2:
      if (context.triggerCharacter) {
        if (context.isRetrigger) {
          return {
            kind: "retrigger",
            triggerCharacter: context.triggerCharacter as any,
          };
        } else {
          return {
            kind: "characterTyped",
            triggerCharacter: context.triggerCharacter as any,
          };
        }
      } else {
        return { kind: "invoked" };
      }

      // SignatureHelpTriggerKind.ContentChange
    case 3:
      return context.isRetrigger ? { kind: "retrigger" } : { kind: "invoked" };

    // SignatureHelpTriggerKind.Invoke
    case 1:
    default:
      return { kind: "invoked" };
  }
}

function toTsFormatOptions({ tabSize, trimTrailingWhitespace, insertSpaces }: lst.FormattingOptions): ts.FormatCodeSettings {
  return {
    tabSize,
    trimTrailingWhitespace,
    indentSize: tabSize,
    convertTabsToSpaces: insertSpaces,
    insertSpaceAfterCommaDelimiter: insertSpaces,
    insertSpaceAfterSemicolonInForStatements: insertSpaces,
    insertSpaceBeforeAndAfterBinaryOperators: insertSpaces,
    insertSpaceAfterKeywordsInControlFlowStatements: insertSpaces,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: insertSpaces,
  };
}

initializeWorker(TypeScriptWorker);
