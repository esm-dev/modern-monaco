import type monacoNS from "monaco-editor-core";
import type * as lst from "vscode-languageserver-types";
import { type ImportMap, isBlankImportMap, resolve } from "@esm.sh/import-map";
import ts from "typescript";
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
} from "vscode-languageserver-types";
import { TextDocument, WorkerBase, type WorkerCreateData } from "../worker-base.ts";

// ! external modules, don't remove the `.js` extension
// @ts-expect-error 'libs.js' is generated at build time
import libs from "./libs.js";
import { cache } from "../../cache.js";
import { initializeWorker } from "../../editor-worker.js";

export interface Host {
  openModel(uri: string): Promise<boolean>;
  refreshDiagnostics(uri: string): Promise<void>;
}

export interface VersionedContent {
  content: string;
  version: number;
}

export interface CreateData extends WorkerCreateData {
  compilerOptions: Record<string, unknown>;
  formatOptions: ts.FormatCodeSettings & Pick<ts.UserPreferences, "quotePreference">;
  importMap: ImportMap;
  types: Record<string, VersionedContent>;
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

export class TypeScriptWorker extends WorkerBase<Host> implements ts.LanguageServiceHost {
  #compilerOptions: ts.CompilerOptions;
  #languageService: ts.LanguageService;
  #formatOptions?: CreateData["formatOptions"];
  #importMap: ImportMap;
  #importMapVersion: number;
  #isBlankImportMap: boolean;
  #types: Record<string, VersionedContent>;
  #urlMappings = new Map<string, string>();
  #typesMappings = new Map<string, string>();
  #httpLibs = new Map<string, string>();
  #httpModules = new Map<string, string>();
  #httpTsModules = new Map<string, string>();
  #redirectedImports: [modelUrl: string, node: ts.Node, url: string][] = [];
  #unknownImports = new Set<string>();
  #badImports = new Set<string>();
  #openPromises = new Map<string, Promise<void>>();
  #fetchPromises = new Map<string, Promise<void>>();
  #httpDocumentCache = new Map<string, TextDocument>();

  constructor(ctx: monacoNS.worker.IWorkerContext<Host>, createData: CreateData) {
    super(ctx, createData);
    this.#compilerOptions = ts.convertCompilerOptionsFromJson(createData.compilerOptions, ".").options;
    this.#languageService = ts.createLanguageService(this);
    this.#importMap = createData.importMap;
    this.#importMapVersion = 0;
    this.#isBlankImportMap = isBlankImportMap(createData.importMap);
    this.#types = createData.types;
    this.#formatOptions = createData.formatOptions;
    this.#updateJsxImportSource();
  }

  // #region language service host

  getCurrentDirectory(): string {
    return "/";
  }

  getDirectories(path: string): string[] {
    if (path === "/node_modules/@types") {
      return [];
    }
    if (path.startsWith("file:///node_modules/")) {
      // todo: use closest index.html(importmap)
      const dirname = path.slice("file:///node_modules/".length);
      return Object.keys(this.#importMap.imports)
        .filter(key => key !== "@jsxRuntime" && (dirname.length === 0 || key.startsWith(dirname)))
        .map(key => dirname.length > 0 ? key.slice(dirname.length) : key)
        .filter((key) => key !== "/" && key.includes("/"))
        .map(key => key.split("/")[0]);
    }
    return this.readDir(path).filter(([_, type]) => type === 2).map(([name, _]) => name);
  }

  readDirectory(
    path: string,
    extensions?: readonly string[],
    exclude?: readonly string[],
    include?: readonly string[],
    depth?: number,
  ): string[] {
    if (path.startsWith("file:///node_modules/")) {
      // todo: use closest index.html(importmap)
      const dirname = path.slice("file:///node_modules/".length);
      return Object.keys(this.#importMap.imports)
        .filter(key => key !== "@jsxRuntime" && (dirname.length === 0 || key.startsWith(dirname)))
        .map(key => dirname.length > 0 ? key.slice(dirname.length) : key)
        .filter((key) => !key.includes("/"));
    }
    return this.readDir(path, extensions).filter(([_, type]) => type === 1).map(([name, _]) => name);
  }

  fileExists(filename: string): boolean {
    if (filename.startsWith("/node_modules/")) return false;
    return (
      filename in libs
      || `lib.${filename}.d.ts` in libs
      || filename in this.#types
      || this.#httpLibs.has(filename)
      || this.#httpModules.has(filename)
      || this.#httpTsModules.has(filename)
      || this.hasModel(filename)
    );
  }

  readFile(filename: string): string | undefined {
    return this.#getScriptText(filename);
  }

  getScriptFileNames(): string[] {
    const models = this.getMirrorModels();
    const types = Object.keys(this.#types);
    const libNames = Object.keys(libs);
    const filenames = new Array<string>(
      models.length + types.length + libNames.length + this.#httpLibs.size + this.#httpModules.size + this.#httpTsModules.size,
    );
    let i = 0;
    for (const model of models) {
      filenames[i++] = model.uri.toString();
    }
    for (const filename of types) {
      filenames[i++] = filename;
    }
    for (const filename of libNames) {
      filenames[i++] = filename;
    }
    for (const filename of this.#httpLibs.keys()) {
      filenames[i++] = filename;
    }
    for (const filename of this.#httpModules.keys()) {
      filenames[i++] = filename;
    }
    for (const filename of this.#httpTsModules.keys()) {
      filenames[i++] = filename;
    }
    return filenames;
  }

  getScriptVersion(fileName: string): string {
    if (fileName in this.#types) {
      return String(this.#types[fileName].version);
    }
    if (
      fileName in libs
      || fileName in this.#types
      || this.#httpLibs.has(fileName)
      || this.#httpModules.has(fileName)
      || this.#httpTsModules.has(fileName)
    ) {
      return "1"; // static/remote modules/types
    }
    const model = this.getModel(fileName);
    if (model) {
      // change on import map will affect all models
      return this.#importMapVersion + "." + model.version;
    }
    // unknown file
    return "0";
  }

  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    const text = this.#getScriptText(fileName);
    if (text === undefined) {
      return undefined;
    }
    return ts.ScriptSnapshot.fromString(text);
  }

  getCompilationSettings(): ts.CompilerOptions {
    return this.#compilerOptions;
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
      case 11 /* ES2024 */:
        return `lib.es${2013 + options.target}.full.d.ts`;
      case 99 /* ESNext */:
        return "lib.esnext.full.d.ts";
      default:
        return "lib.es6.d.ts";
    }
  }

  resolveModuleNameLiterals(
    moduleLiterals: readonly ts.StringLiteralLike[],
    containingFile: string,
    _redirectedReference: ts.ResolvedProjectReference | undefined,
    _options: ts.CompilerOptions,
    _containingSourceFile: ts.SourceFile,
    _reusedNames: readonly ts.StringLiteralLike[] | undefined,
  ): readonly ts.ResolvedModuleWithFailedLookupLocations[] {
    this.#redirectedImports = this.#redirectedImports.filter(([modelUrl]) => modelUrl !== containingFile);
    return moduleLiterals.map((literal): ts.ResolvedModuleWithFailedLookupLocations["resolvedModule"] => {
      let specifier = literal.text;
      let importMapResolved = false;
      if (!this.#isBlankImportMap) {
        const [url, resolved] = resolve(this.#importMap, specifier, containingFile);
        importMapResolved = resolved;
        if (importMapResolved) {
          specifier = url;
        }
      }
      if (!importMapResolved && !isHttpUrl(specifier) && !isRelativePath(specifier)) {
        return undefined;
      }
      let moduleUrl: URL;
      try {
        moduleUrl = new URL(specifier, pathToUrl(containingFile));
      } catch (error) {
        return undefined;
      }
      if (getScriptExtension(moduleUrl.pathname) === null) {
        const ext = getScriptExtension(containingFile);
        // use the extension of the containing file which is a dts file
        // when the module name has no extension.
        if (ext === ".d.ts" || ext === ".d.mts" || ext === ".d.cts") {
          moduleUrl.pathname += ext;
        }
      }
      if (this.#httpModules.has(containingFile)) {
        // ignore dependencies of http modules
        return {
          resolvedFileName: moduleUrl.href,
          extension: ".js",
        };
      }
      if (moduleUrl.protocol === "file:") {
        const moduleHref = moduleUrl.href;
        if (this.#badImports.has(moduleHref)) {
          return undefined;
        }
        for (const model of this.getMirrorModels()) {
          if (moduleHref === model.uri.toString()) {
            return {
              resolvedFileName: moduleHref,
              extension: getScriptExtension(moduleUrl.pathname) ?? ".js",
            };
          }
        }
        if (!this.hasFileSystemProvider) {
          return undefined;
        }
        if (!this.#openPromises.has(moduleHref)) {
          this.#openPromises.set(
            moduleHref,
            this.host.openModel(moduleHref).then((ok) => {
              if (!ok) {
                this.#badImports.add(moduleHref);
                this.#rollbackVersion(containingFile);
              }
            }).finally(() => {
              this.#openPromises.delete(moduleHref);
              this.host.refreshDiagnostics(containingFile);
            }),
          );
        }
      } else {
        const moduleHref = moduleUrl.href;
        if (this.#badImports.has(moduleHref) || this.#unknownImports.has(moduleHref)) {
          return undefined;
        }
        if (!importMapResolved && this.#urlMappings.has(moduleHref)) {
          const redirectUrl = this.#urlMappings.get(moduleHref)!;
          this.#redirectedImports.push([containingFile, literal, redirectUrl]);
        }
        if (this.#httpModules.has(moduleHref)) {
          return {
            resolvedFileName: moduleHref,
            extension: getScriptExtension(moduleUrl.pathname) ?? ".js",
          };
        }
        if (this.#httpTsModules.has(moduleHref)) {
          return {
            resolvedFileName: moduleHref,
            extension: getScriptExtension(moduleUrl.pathname) ?? ".ts",
          };
        }
        if (this.#typesMappings.has(moduleHref)) {
          return {
            resolvedFileName: this.#typesMappings.get(moduleHref)!,
            extension: ".d.ts",
          };
        }
        if (this.#httpLibs.has(moduleHref)) {
          return {
            resolvedFileName: moduleHref,
            extension: ".d.ts",
          };
        }
        if (!this.#fetchPromises.has(moduleHref)) {
          const autoFetch = importMapResolved || this.#isJsxImportUrl(specifier) || isHttpUrl(containingFile)
            || isWellKnownCDNURL(moduleUrl);
          const promise = autoFetch ? cache.fetch(moduleUrl) : cache.query(moduleUrl);
          this.#fetchPromises.set(
            moduleHref,
            promise.then(async (res) => {
              if (!res) {
                // did not find the module in the cache
                this.#unknownImports.add(moduleHref);
                return;
              }
              if (res.ok) {
                const contentType = res.headers.get("content-type");
                const dts = res.headers.get("x-typescript-types");
                if (res.redirected) {
                  this.#urlMappings.set(moduleHref, res.url);
                } else if (dts) {
                  res.body?.cancel();
                  const dtsRes = await cache.fetch(new URL(dts, res.url));
                  if (dtsRes.ok) {
                    this.#typesMappings.set(moduleHref, dtsRes.url);
                    this.#markHttpLib(dtsRes.url, await dtsRes.text());
                  }
                } else if (
                  /\.(c|m)?jsx?$/.test(moduleUrl.pathname)
                  || (contentType && /^(application|text)\/(javascript|jsx)/.test(contentType))
                ) {
                  this.#httpModules.set(moduleHref, await res.text());
                } else if (
                  /\.(c|m)?tsx?$/.test(moduleUrl.pathname)
                  || (contentType && /^(application|text)\/(typescript|tsx)/.test(contentType))
                ) {
                  if (/\.d\.(c|m)?ts$/.test(moduleUrl.pathname)) {
                    this.#markHttpLib(moduleHref, await res.text());
                  } else {
                    this.#httpTsModules.set(moduleHref, await res.text());
                  }
                } else {
                  // not a javascript or typescript module
                  res.body?.cancel();
                  this.#badImports.add(moduleHref);
                }
              } else {
                // bad response
                res.body?.cancel();
                this.#badImports.add(moduleHref);
              }
            }).catch((err) => {
              console.error(`Failed to fetch module: ${moduleHref}`, err);
            }).finally(() => {
              this.#rollbackVersion(containingFile);
              this.#fetchPromises.delete(moduleHref);
              this.host.refreshDiagnostics(containingFile);
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
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const ext = getScriptExtension(uri);
    const diagnostics: lst.Diagnostic[] = [];
    for (const diagnostic of this.#languageService.getSyntacticDiagnostics(uri)) {
      diagnostics.push(this.#convertDiagnostic(document, diagnostic));
    }
    for (const diagnostic of this.#languageService.getSuggestionDiagnostics(uri)) {
      diagnostics.push(this.#convertDiagnostic(document, diagnostic));
    }
    if (ext === ".tsx" || ext?.endsWith("ts")) {
      for (const diagnostic of this.#languageService.getSemanticDiagnostics(uri)) {
        diagnostics.push(this.#convertDiagnostic(document, diagnostic));
      }
    }
    if (this.#redirectedImports.length > 0) {
      this.#redirectedImports.forEach(([modelUrl, node, url]) => {
        if (modelUrl === uri) {
          diagnostics.push(this.#convertDiagnostic(document, {
            file: undefined,
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

  async doAutoComplete(uri: string, position: lst.Position, ch: string): Promise<string | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const info = this.#languageService.getJsxClosingTagAtPosition(uri, document.offsetAt(position));
    if (info) {
      return "$0" + info.newText;
    }
    return null;
  }

  async doComplete(uri: string, position: lst.Position): Promise<lst.CompletionList | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const offset = document.offsetAt(position);
    const completions = this.#getCompletionsAtPosition(uri, offset);
    if (!completions) {
      return { isIncomplete: false, items: [] };
    }
    const items: lst.CompletionItem[] = [];
    for (const entry of completions.entries) {
      if (entry.name === "") {
        continue;
      }
      // drop import completions that are in the import map for '.' and '..' imports
      if (entry.kind === "script" && entry.name in this.#importMap.imports || entry.name + "/" in this.#importMap.imports) {
        const { replacementSpan } = entry;
        if (replacementSpan?.length) {
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
      const data = { entryData: entry.data, context: { uri, offset } };
      const tags: lst.CompletionItemTag[] = [];
      if (entry.kindModifiers?.includes("deprecated")) {
        tags.push(CompletionItemTag.Deprecated);
      }
      items.push({
        label: entry.name,
        insertText: entry.name,
        filterText: entry.filterText,
        sortText: entry.sortText,
        kind: convertTsCompletionItemKind(entry.kind),
        tags,
        data,
      });
    }
    return {
      isIncomplete: !!completions.isIncomplete,
      items: items,
    };
  }

  async doResolveCompletionItem(item: lst.CompletionItem): Promise<lst.CompletionItem | null> {
    if (!item.data?.context) {
      return null;
    }
    const { uri, offset } = item.data.context;
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const details = this.#getCompletionEntryDetails(uri, offset, item.label, item.data.entryData);
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
              range: createRangeFromDocumentSpan(document, span),
              newText,
            });
          })
        )
      );
    }
    return { label: item.label, detail, documentation, additionalTextEdits };
  }

  async doHover(uri: string, position: lst.Position): Promise<lst.Hover | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }

    const info = this.#getQuickInfoAtPosition(uri, document.offsetAt(position));
    if (info) {
      const contents = ts.displayPartsToString(info.displayParts);
      const documentation = ts.displayPartsToString(info.documentation);
      const tags = info.tags?.map((tag) => tagStringify(tag)).join("  \n\n") ?? null;
      return {
        range: createRangeFromDocumentSpan(document, info.textSpan),
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
    const triggerReason = toTsSignatureHelpTriggerReason(context);
    const items = this.#languageService.getSignatureHelpItems(uri, position, { triggerReason });
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
        if (signature.parameters) {
          signature.parameters.push(parameter);
        } else {
          signature.parameters = [parameter];
        }
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
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    const errorCodes = context.diagnostics.map(diagnostic => diagnostic.code).filter(Boolean).map(Number);
    const codeFixes = await this.#getCodeFixesAtPosition(uri, start, end, errorCodes, toTsFormatOptions(formatOptions));
    return codeFixes.map(codeFix => {
      const action: lst.CodeAction = {
        title: codeFix.description,
        kind: "quickfix",
      };
      if (codeFix.changes.length > 0) {
        const edits: lst.TextEdit[] = [];
        for (const change of codeFix.changes) {
          for (const { span, newText } of change.textChanges) {
            edits.push({ range: createRangeFromDocumentSpan(document, span), newText });
          }
        }
        action.edit = { changes: { [uri]: edits } };
      }
      if (codeFix.commands?.length) {
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
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }

    const documentPosition = document.offsetAt(position);
    const renameInfo = this.#languageService.getRenameInfo(uri, documentPosition, { allowRenameOfImportPath: true });
    if (!renameInfo.canRename) {
      return null;
    }
    const locations = this.#languageService.findRenameLocations(uri, documentPosition, false, false, {
      providePrefixAndSuffixTextForRename: false,
    });
    if (!locations) {
      return null;
    }
    const changes: Record<string, lst.TextEdit[]> = {};
    locations.map(loc => {
      const edits = changes[loc.fileName] || (changes[loc.fileName] = []);
      const locDocument = this.#getTextDocument(loc.fileName);
      if (locDocument) {
        edits.push({
          range: createRangeFromDocumentSpan(locDocument, loc.textSpan),
          newText: newName,
        });
      }
    });
    return { changes };
  }

  async doFormat(
    uri: string,
    range: lst.Range | null,
    formatOptions: lst.FormattingOptions,
    docText?: string,
  ): Promise<lst.TextEdit[] | null> {
    const document = docText ? TextDocument.create(uri, "typescript", 0, docText) : this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const formattingOptions = this.#mergeFormatOptions(toTsFormatOptions(formatOptions));
    let edits: ts.TextChange[];
    if (range) {
      const start = document.offsetAt(range.start);
      const end = document.offsetAt(range.end);
      edits = this.#languageService.getFormattingEditsForRange(uri, start, end, formattingOptions);
    } else {
      edits = this.#languageService.getFormattingEditsForDocument(uri, formattingOptions);
    }
    return edits.map(({ span, newText }) => ({
      range: createRangeFromDocumentSpan(document, span),
      newText,
    }));
  }

  async findDocumentSymbols(uri: string): Promise<lst.DocumentSymbol[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const toSymbol = (item: ts.NavigationTree, containerLabel?: string): lst.DocumentSymbol => {
      const result: lst.DocumentSymbol = {
        name: item.text,
        kind: convertTsSymbolKind(item.kind),
        range: createRangeFromDocumentSpan(document, item.spans[0]),
        selectionRange: createRangeFromDocumentSpan(document, item.spans[0]),
        children: item.childItems?.map((child) => toSymbol(child, item.text)),
      };
      if (containerLabel) {
        Reflect.set(result, "containerName", containerLabel);
      }
      return result;
    };
    const root = this.#languageService.getNavigationTree(uri);
    return root.childItems?.map((item) => toSymbol(item)) ?? null;
  }

  async findDefinition(uri: string, position: lst.Position): Promise<lst.LocationLink[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const res = this.#languageService.getDefinitionAndBoundSpan(uri, document.offsetAt(position));
    if (res) {
      const { definitions, textSpan } = res;
      if (definitions) {
        return definitions.map(d => {
          const targetDocument = d.fileName === uri ? document : this.#getTextDocument(d.fileName);
          if (targetDocument) {
            const range = createRangeFromDocumentSpan(targetDocument, d.textSpan);
            const link: lst.LocationLink = {
              targetUri: d.fileName,
              targetRange: range,
              targetSelectionRange: undefined as unknown as lst.Range,
            };
            if (d.contextSpan) {
              link.targetRange = createRangeFromDocumentSpan(targetDocument, d.contextSpan);
              link.targetSelectionRange = range;
            }
            if (d.kind === "script" || d.kind === "module") {
              // strip quotes
              link.originSelectionRange = createRangeFromDocumentSpan(document, {
                start: textSpan.start + 1,
                length: textSpan.length - 2,
              });
            } else {
              link.originSelectionRange = createRangeFromDocumentSpan(document, textSpan);
            }
            return link;
          }
          return undefined;
        }).filter(d => d !== undefined);
      }
    }
    return null;
  }

  async findReferences(uri: string, position: lst.Position): Promise<lst.Location[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const references = this.#languageService.getReferencesAtPosition(uri, document.offsetAt(position));
    const result: lst.Location[] = [];
    if (references) {
      for (let entry of references) {
        const entryDocument = this.#getTextDocument(entry.fileName);
        if (entryDocument) {
          result.push({
            uri: entryDocument.uri,
            range: createRangeFromDocumentSpan(entryDocument, entry.textSpan),
          });
        }
      }
    }
    return result;
  }

  async findDocumentHighlights(uri: string, position: lst.Position): Promise<lst.DocumentHighlight[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const highlights = this.#languageService.getDocumentHighlights(uri, document.offsetAt(position), [uri]);
    const out: lst.DocumentHighlight[] = [];
    for (const entry of highlights || []) {
      for (const highlight of entry.highlightSpans) {
        out.push({
          range: createRangeFromDocumentSpan(document, highlight.textSpan),
          kind: highlight.kind === "writtenReference" ? DocumentHighlightKind.Write : DocumentHighlightKind.Text,
        });
      }
    }
    return out;
  }

  async getFoldingRanges(uri: string): Promise<lst.FoldingRange[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const spans = this.#languageService.getOutliningSpans(uri);
    const ranges: lst.FoldingRange[] = [];
    for (const span of spans) {
      const curr = createRangeFromDocumentSpan(document, span.textSpan);
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
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    function convertSelectionRange(selectionRange: ts.SelectionRange): lst.SelectionRange {
      const parent = selectionRange.parent ? convertSelectionRange(selectionRange.parent) : undefined;
      return SelectionRange.create(createRangeFromDocumentSpan(document!, selectionRange.textSpan), parent);
    }
    return positions.map(position => {
      const range = this.#languageService.getSmartSelectionRange(uri, document.offsetAt(position));
      return convertSelectionRange(range);
    });
  }

  // #endregion

  // #region public methods used by the host

  async fetchHttpModule(specifier: string, containingFile: string): Promise<void> {
    if (this.#unknownImports.has(specifier)) {
      const res = await cache.fetch(specifier);
      res.body?.cancel();
      this.#unknownImports.delete(specifier);
      if (!res.ok) {
        this.#badImports.add(specifier);
      }
      this.#rollbackVersion(containingFile);
      this.host.refreshDiagnostics(containingFile);
    }
  }

  async updateCompilerOptions(options: {
    compilerOptions?: Record<string, unknown>;
    importMap?: ImportMap;
    types?: Record<string, VersionedContent>;
  }): Promise<void> {
    const { compilerOptions, importMap, types } = options;
    if (compilerOptions) {
      this.#compilerOptions = ts.convertCompilerOptionsFromJson(compilerOptions, ".").options;
      this.#updateJsxImportSource();
    }
    if (importMap) {
      this.#importMap = importMap;
      this.#importMapVersion++;
      this.#isBlankImportMap = isBlankImportMap(importMap);
      this.#updateJsxImportSource();
    }
    if (types) {
      for (const uri of Object.keys(this.#types)) {
        if (!(uri in types)) {
          this.releaseDocument(uri);
        }
      }
      this.#types = types;
    }
  }

  // #endregion

  // #region private methods

  #getCompletionsAtPosition(fileName: string, position: number): ts.CompletionInfo | undefined {
    const completions = this.#languageService.getCompletionsAtPosition(
      fileName,
      position,
      {
        quotePreference: this.#formatOptions?.quotePreference,
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
        if (!data || !data.fileName || !isDts(data.fileName)) {
          return true;
        }
        const { moduleSpecifier, exportName } = data;
        if (moduleSpecifier && (moduleSpecifier in this.#importMap.imports || this.#typesMappings.has(moduleSpecifier))) {
          autoImports.add(exportName + " " + moduleSpecifier);
          return true;
        }
        const specifier = this.#getSpecifierFromDts(data.fileName);
        if (specifier && !autoImports.has(exportName + " " + specifier)) {
          autoImports.add(exportName + " " + specifier);
          return true;
        }
        return false;
      });
      return completions;
    }
    return undefined;
  }

  #getCompletionEntryDetails(
    fileName: string,
    position: number,
    entryName: string,
    data?: ts.CompletionEntryData,
  ): ts.CompletionEntryDetails | undefined {
    try {
      const detail = this.#languageService.getCompletionEntryDetails(
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
          const newSpecifier = this.#getSpecifierFromDts(isDts(specifier) ? specifier : specifier + ".d.ts");
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

  #getQuickInfoAtPosition(fileName: string, position: number): ts.QuickInfo | undefined {
    const info = this.#languageService.getQuickInfoAtPosition(fileName, position);
    if (!info) {
      return;
    }

    // pettier display for module specifiers
    const { kind, kindModifiers, displayParts, textSpan } = info;
    if (kind === ts.ScriptElementKind.moduleElement && displayParts?.length === 3) {
      const moduleName = displayParts[2].text;
      // show pathname for `file:` specifiers
      if (moduleName.startsWith('"file:') && fileName.startsWith("file:")) {
        const literalText = this.getModel(fileName)?.getValue().substring(
          textSpan.start,
          textSpan.start + textSpan.length,
        );
        if (literalText) {
          try {
            const specifier = JSON.parse(literalText);
            displayParts[2].text = '"' + new URL(specifier, fileName).pathname + '"';
          } catch (error) {
            // ignore
          }
        }
      } else if (
        // show module url for `http:` specifiers instead of the types url
        kindModifiers === "declare" && moduleName.startsWith('"http')
      ) {
        const specifier = JSON.parse(moduleName);
        for (const [url, dts] of this.#typesMappings) {
          if (specifier + ".d.ts" === dts) {
            displayParts[2].text = '"' + url + '"';
            info.tags = [{
              name: "types",
              text: [{ kind: "text", text: dts }],
            }];
            const { pathname, hostname } = new URL(url);
            if (isEsmshHost(hostname)) {
              const pathSegments = pathname.split("/").slice(1);
              if (/^v\d+$/.test(pathSegments[0])) {
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

  async #getCodeFixesAtPosition(
    fileName: string,
    start: number,
    end: number,
    errorCodes: number[],
    formatOptions: ts.FormatCodeSettings,
  ): Promise<ts.CodeFixAction[]> {
    let span = [start + 1, end - 1] as [number, number];
    // fix url/path span
    if (start === end && (this.#redirectedImports.length > 0 || errorCodes.includes(2307))) {
      const a = this.#languageService.getReferencesAtPosition(fileName, start);
      if (a && a.length > 0) {
        const b = a[0];
        span = [b.textSpan.start, b.textSpan.start + b.textSpan.length];
      }
    }
    const fixes: ts.CodeFixAction[] = [];
    if (this.#redirectedImports.length > 0) {
      const i = this.#redirectedImports.findIndex(([modelUrl, node]) => {
        return fileName === modelUrl && node.getStart() === span[0] - 1 && node.getEnd() === span[1] + 1;
      });
      if (i >= 0) {
        const [_, node, url] = this.#redirectedImports[i];
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
      const specifier = this.getModel(fileName)?.getValue().slice(...span);
      if (specifier) {
        if (this.#unknownImports.has(specifier)) {
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
      const tsFixes = this.#languageService.getCodeFixesAtPosition(
        fileName,
        start,
        end,
        errorCodes,
        this.#mergeFormatOptions(formatOptions),
        {},
      );
      return fixes.concat(tsFixes);
    } catch (err) {
      return fixes;
    }
  }

  /** rollback the version to force reinvoke `resolveModuleNameLiterals` method. */
  #rollbackVersion(fileName: string) {
    const model = this.getModel(fileName);
    if (model) {
      // @ts-expect-error private field
      model._versionId--;
    }
  }

  #getScriptText(fileName: string): string | undefined {
    return libs[fileName]
      ?? libs[`lib.${fileName}.d.ts`]
      ?? this.#types[fileName]?.content
      ?? this.#httpLibs.get(fileName)
      ?? this.#httpModules.get(fileName)
      ?? this.#httpTsModules.get(fileName)
      ?? this.getModel(fileName)?.getValue();
  }

  #getTextDocument(uri: string): TextDocument | null {
    const doc = this.getTextDocument(uri);
    if (doc) {
      return doc;
    }
    if (uri.startsWith("http://") || uri.startsWith("https://")) {
      const docCache = this.#httpDocumentCache;
      if (docCache.has(uri)) {
        return docCache.get(uri)!;
      }
      const scriptText = this.#getScriptText(uri);
      if (scriptText) {
        const doc = TextDocument.create(uri, "typescript", 1, scriptText);
        docCache.set(uri, doc);
        return doc;
      }
    }
    return null;
  }

  #markHttpLib(url: string, dtsContent: string): void {
    this.#httpLibs.set(url, dtsContent);
    setTimeout(() => {
      // resolve types reference directives
      // e.g. `/// <reference types="./common.d.ts" />`
      const referencedFiles = this.#languageService.getProgram()?.getSourceFile(url)?.referencedFiles ?? [];
      referencedFiles.forEach((ref) => {
        const refUrl = new URL(ref.fileName, url).href;
        if (isDts(refUrl) && !this.#fetchPromises.has(refUrl) && !this.#httpLibs.has(refUrl) && !this.#badImports.has(refUrl)) {
          this.#fetchPromises.set(
            refUrl,
            cache.fetch(refUrl).then(async res => {
              if (res.ok) {
                this.#httpLibs.set(refUrl, await res.text());
              } else {
                this.#badImports.add(refUrl);
              }
            }).catch(err => {
              console.error(`Failed to fetch types: ${refUrl}`, err);
            }).finally(() => {
              this.#fetchPromises.delete(refUrl);
            }),
          );
        }
      });
    });
  }

  #getSpecifierFromDts(filename: string): string | void {
    for (const [specifier, dts] of this.#typesMappings) {
      if (filename === dts) {
        if (!this.#isBlankImportMap) {
          for (const [key, value] of Object.entries(this.#importMap.imports)) {
            if (value === specifier && key !== "@jsxRuntime") {
              return key;
            }
          }
        }
        return specifier;
      }
    }
  }

  #convertDiagnostic(document: TextDocument, diagnostic: ts.Diagnostic): lst.Diagnostic {
    const tags: lst.DiagnosticTag[] = [];
    if (diagnostic.reportsUnnecessary) {
      tags.push(DiagnosticTag.Unnecessary);
    }
    if (diagnostic.reportsDeprecated) {
      tags.push(DiagnosticTag.Deprecated);
    }
    return {
      range: createRangeFromDocumentSpan(document, diagnostic),
      code: diagnostic.code,
      severity: convertTsDiagnosticCategory(diagnostic.category),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      source: diagnostic.source,
      tags,
      relatedInformation: this.#convertRelatedInformation(document, diagnostic.relatedInformation),
    };
  }

  #convertRelatedInformation(
    document: TextDocument,
    relatedInformation?: ts.DiagnosticRelatedInformation[],
  ): lst.DiagnosticRelatedInformation[] {
    if (!relatedInformation) {
      return [];
    }

    const result: lst.DiagnosticRelatedInformation[] = [];
    relatedInformation.forEach((info) => {
      const doc = info.file ? this.#getTextDocument(info.file.fileName) : document;
      if (!doc) {
        return;
      }

      const start = doc.positionAt(info.start ?? 0);
      const end = doc.positionAt((info.start ?? 0) + (info.length ?? 1));
      result.push({
        location: {
          uri: document.uri,
          range: Range.create(start, end),
        },
        message: ts.flattenDiagnosticMessageText(info.messageText, "\n"),
      });
    });
    return result;
  }

  #getJsxImportSource(): string | undefined {
    const { imports } = this.#importMap;
    for (const specifier of ["@jsxRuntime", "@jsxImportSource", "preact", "react"]) {
      if (specifier in imports) {
        return imports[specifier];
      }
    }
    return undefined;
  }

  #updateJsxImportSource(): void {
    if (!this.#compilerOptions.jsxImportSource) {
      const jsxImportSource = this.#getJsxImportSource();
      if (jsxImportSource) {
        this.#compilerOptions.jsx = ts.JsxEmit.React;
        this.#compilerOptions.jsxImportSource = jsxImportSource;
      }
    }
  }

  #mergeFormatOptions(formatOptions: ts.FormatCodeSettings): ts.FormatCodeSettings {
    return { ...this.#formatOptions, ...formatOptions };
  }

  #isJsxImportUrl(url: string): boolean {
    const jsxImportUrl = this.#getJsxImportSource();
    if (jsxImportUrl) {
      return url === jsxImportUrl + "/jsx-runtime" || url === jsxImportUrl + "/jsx-dev-runtime";
    }
    return false;
  }

  // #endregion
}

function getScriptExtension(url: URL | string): string | null {
  const pathname = typeof url === "string" ? pathToUrl(url).pathname : url.pathname;
  const basename = pathname.substring(pathname.lastIndexOf("/") + 1);
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex === -1) {
    return null;
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

function isEsmshHost(hostname: string): boolean {
  return hostname === "esm.sh" || hostname.endsWith(".esm.sh");
}

const regexpPackagePath = /\/((@|gh\/|pr\/|jsr\/@)[\w\.\-]+\/)?[\w\.\-]+@(\d+(\.\d+){0,2}(\-[\w\.]+)?|next|canary|rc|beta|latest)$/;
function isWellKnownCDNURL(url: URL): boolean {
  const { pathname } = url;
  return regexpPackagePath.test(pathname);
}

function isDts(fileName: string): boolean {
  return fileName.endsWith(".d.ts") || fileName.endsWith(".d.mts") || fileName.endsWith(".d.cts");
}

function pathToUrl(path: string): URL {
  return new URL(path, "file:///");
}

function createRangeFromDocumentSpan(document: TextDocument, span: { start?: number; length?: number }): lst.Range {
  if (typeof span.start === "undefined") {
    const pos = document.positionAt(0);
    return Range.create(pos, pos);
  }
  const start = document.positionAt(span.start);
  const end = document.positionAt(span.start + (span.length ?? 0));
  return Range.create(start, end);
}

function convertTsCompletionItemKind(kind: ts.ScriptElementKind): lst.CompletionItemKind {
  const ScriptElementKind = ts.ScriptElementKind;
  switch (kind) {
    case ScriptElementKind.primitiveType:
    case ScriptElementKind.keyword:
      return CompletionItemKind.Keyword;
    case ScriptElementKind.constElement:
    case ScriptElementKind.letElement:
    case ScriptElementKind.variableElement:
    case ScriptElementKind.localVariableElement:
    case ScriptElementKind.alias:
    case ScriptElementKind.parameterElement:
      return CompletionItemKind.Variable;
    case ScriptElementKind.memberVariableElement:
    case ScriptElementKind.memberGetAccessorElement:
    case ScriptElementKind.memberSetAccessorElement:
      return CompletionItemKind.Field;
    case ScriptElementKind.functionElement:
    case ScriptElementKind.localFunctionElement:
      return CompletionItemKind.Function;
    case ScriptElementKind.memberFunctionElement:
    case ScriptElementKind.constructSignatureElement:
    case ScriptElementKind.callSignatureElement:
    case ScriptElementKind.indexSignatureElement:
      return CompletionItemKind.Method;
    case ScriptElementKind.enumElement:
      return CompletionItemKind.Enum;
    case ScriptElementKind.enumMemberElement:
      return CompletionItemKind.EnumMember;
    case ScriptElementKind.moduleElement:
    case ScriptElementKind.externalModuleName:
      return CompletionItemKind.Module;
    case ScriptElementKind.classElement:
    case ScriptElementKind.typeElement:
      return CompletionItemKind.Class;
    case ScriptElementKind.interfaceElement:
      return CompletionItemKind.Interface;
    case ScriptElementKind.warning:
      return CompletionItemKind.Text;
    case ScriptElementKind.scriptElement:
      return CompletionItemKind.File;
    case ScriptElementKind.directory:
      return CompletionItemKind.Folder;
    case ScriptElementKind.string:
      return CompletionItemKind.Constant;
    default:
      return CompletionItemKind.Property;
  }
}

function convertTsSymbolKind(kind: ts.ScriptElementKind): lst.SymbolKind {
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

function convertTsDiagnosticCategory(category: ts.DiagnosticCategory): lst.DiagnosticSeverity {
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

function tagStringify(tag: ts.JSDocTagInfo): string {
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

function toTsSignatureHelpTriggerReason(context: monacoNS.languages.SignatureHelpContext): ts.SignatureHelpTriggerReason {
  switch (context.triggerKind) {
    case 3 /* ContentChange */:
      return context.isRetrigger ? { kind: "retrigger" } : { kind: "invoked" };
    case 2 /* TriggerCharacter */:
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
    case 1 /* Invoke */:
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
