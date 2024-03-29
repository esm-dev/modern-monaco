/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) X. <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type monacoNS from "monaco-editor-core";
import type * as lst from "vscode-languageserver-types";
import {
  CompletionItemKind,
  DiagnosticSeverity,
  DocumentHighlightKind,
  FoldingRangeKind,
  Range,
  TextDocument,
  TextEdit,
} from "vscode-languageserver-types";
import ts from "typescript";
import { type ImportMap, isBlank, resolve } from "../../import-map.js";
import { cache } from "../../cache.js";

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
  hasVFS: boolean;
  formatOptions?: ts.FormatCodeSettings & Pick<ts.UserPreferences, "quotePreference">;
  inlayHintsOptions?: ts.UserPreferences;
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
  private _hasVFS: boolean;
  private _formatOptions?: ts.FormatCodeSettings & Pick<ts.UserPreferences, "quotePreference">;
  private _inlayHintsOptions?: ts.UserPreferences;
  private _languageService = ts.createLanguageService(this);
  private _httpLibs = new Map<string, string>();
  private _httpModules = new Map<string, string>();
  private _httpTsModules = new Map<string, string>();
  private _httpRedirects: { node: ts.Node; url: string }[] = [];
  private _dtsMap = new Map<string, string>();
  private _unknownModules = new Set<string>();
  private _naModules = new Set<string>();
  private _openPromises = new Map<string, Promise<void>>();
  private _fetchPromises = new Map<string, Promise<void>>();
  private _refreshDiagnosticsTimer: number | null = null;

  constructor(
    ctx: monacoNS.worker.IWorkerContext<Host>,
    createData: CreateData,
  ) {
    this._ctx = ctx;
    this._compilerOptions = createData.compilerOptions;
    this._importMap = createData.importMap;
    this._importMapVersion = 0;
    this._isBlankImportMap = isBlank(createData.importMap);
    this._hasVFS = createData.hasVFS;
    this._libs = createData.libs;
    this._types = createData.types;
    this._formatOptions = createData.formatOptions;
    this._inlayHintsOptions = createData.inlayHintsOptions;
  }

  // #region language service host

  getCurrentDirectory(): string {
    return "/";
  }

  readFile(filename: string): string | undefined {
    return this._getScriptText(filename);
  }

  fileExists(filename: string): boolean {
    if (filename.startsWith("/node_modules/")) return false;
    return this._fileExists(filename);
  }

  getCompilationSettings(): ts.CompilerOptions {
    if (!this._compilerOptions.jsxImportSource) {
      const jsxImportSource = this._importMap.imports["@jsxImportSource"];
      if (jsxImportSource) {
        const compilerOptions = { ...this._compilerOptions };
        compilerOptions.jsxImportSource = jsxImportSource;
        if (!compilerOptions.jsx) {
          compilerOptions.jsx = ts.JsxEmit.ReactJSX;
        }
        return compilerOptions;
      }
    }
    return this._compilerOptions;
  }

  getScriptFileNames(): string[] {
    return this._ctx.getMirrorModels()
      .map((model) => model.uri.toString())
      .concat(
        Object.keys(this._types),
        [...this._httpLibs.keys()],
        [...this._httpModules.keys()],
        [...this._httpTsModules.keys()],
      );
  }

  getScriptVersion(fileName: string): string {
    if (fileName in this._types) {
      return String(this._types[fileName].version);
    }
    let model = this._getModel(fileName);
    if (model) {
      return model.version + "." + this._importMapVersion;
    }
    return "1"; // default lib is static
  }

  async getScriptText(fileName: string): Promise<string | undefined> {
    return this._getScriptText(fileName);
  }

  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    const text = this._getScriptText(fileName);
    if (text === undefined) {
      return;
    }
    return {
      getText: (start, end) => text.substring(start, end),
      getLength: () => text.length,
      getChangeRange: () => undefined,
    };
  }

  getScriptKind(fileName: string): ts.ScriptKind {
    if (fileName in this._libs || fileName in this._types || this._httpLibs.has(fileName)) {
      return ts.ScriptKind.TS;
    }
    if (this._httpModules.has(fileName)) {
      return ts.ScriptKind.JS;
    }
    const { pathname } = new URL(fileName, "file:///");
    const basename = pathname.substring(pathname.lastIndexOf("/") + 1);
    const dotIndex = basename.lastIndexOf(".");
    if (dotIndex === -1) {
      return ts.ScriptKind.JS;
    }
    const ext = basename.substring(dotIndex + 1);
    switch (ext) {
      case "mts":
      case "ts":
        return ts.ScriptKind.TS;
      case "tsx":
        return ts.ScriptKind.TSX;
      case "mjs":
      case "js":
        return ts.ScriptKind.JS;
      case "jsx":
        return ts.ScriptKind.JSX;
      case "json":
        return ts.ScriptKind.JSON;
      default:
        return ts.ScriptKind.JS;
    }
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string {
    switch (options.target) {
      case 99 /* ESNext */:
        const esnext = "lib.esnext.full.d.ts";
        if (esnext in this._libs || esnext in this._types) return esnext;
      case 7 /* ES2020 */:
      case 6 /* ES2019 */:
      case 5 /* ES2018 */:
      case 4 /* ES2017 */:
      case 3 /* ES2016 */:
      case 2 /* ES2015 */:
      default:
        // Support a dynamic lookup for the ES20XX version based on the target
        // which is safe unless TC39 changes their numbering system
        const eslib = `lib.es${2013 + (options.target || 99)}.full.d.ts`;
        // Note: This also looks in _types, If you want
        // to add support for additional target options, you will need to
        // add the extra dts files to _types via the API.
        if (eslib in this._libs || eslib in this._types) {
          return eslib;
        }

        return "lib.es6.d.ts"; // We don't use lib.es2015.full.d.ts due to breaking change.
      case 1:
      case 0:
        return "lib.d.ts";
    }
  }

  // async getLibFiles(): Promise<Record<string, string>> {
  //   return this._libs;
  // }

  resolveModuleNameLiterals(
    moduleLiterals: readonly ts.StringLiteralLike[],
    containingFile: string,
    redirectedReference: ts.ResolvedProjectReference | undefined,
    options: ts.CompilerOptions,
    containingSourceFile: ts.SourceFile,
    reusedNames: readonly ts.StringLiteralLike[] | undefined,
  ): readonly ts.ResolvedModuleWithFailedLookupLocations[] {
    const jsxImportUrl = this._getJsxImportUrl();
    return moduleLiterals.map((literal): ts.ResolvedModuleWithFailedLookupLocations["resolvedModule"] => {
      let specifier = literal.text;
      let isJsxImportSource = specifier === jsxImportUrl;
      let inImportMap = false;
      if (!this._isBlankImportMap) {
        if (!isJsxImportSource) {
          isJsxImportSource = specifier === jsxImportUrl;
        }
        const url = resolve(this._importMap, specifier, containingFile);
        inImportMap = url !== specifier;
        specifier = url;
      }
      if (!/^(((file|https?):\/\/)|\.{0,2}\/)/.test(specifier)) {
        return undefined;
      }
      const moduleUrl = new URL(specifier, containingFile);
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
        const moduleName = moduleUrl.href;
        for (const model of this._ctx.getMirrorModels()) {
          if (moduleName === model.uri.toString()) {
            return {
              resolvedFileName: moduleName,
              extension: getScriptExtension(moduleUrl.pathname),
            };
          }
        }
        if (!this._hasVFS) {
          return undefined;
        }
        if (!this._openPromises.has(moduleName)) {
          this._openPromises.set(
            moduleName,
            this._ctx.host.openModel(moduleName).then((ok) => {
              if (!ok) {
                this._naModules.add(moduleName);
                this._rollbackVersion(containingFile);
              }
            }).finally(() => {
              this._openPromises.delete(moduleName);
              if (this._openPromises.size === 0) {
                this._refreshDiagnostics();
              }
            }),
          );
        }
      } else {
        const moduleName = moduleUrl.href;
        if (this._naModules.has(moduleName) || this._unknownModules.has(moduleName)) {
          return undefined;
        }
        if (this._httpModules.has(moduleName)) {
          return {
            resolvedFileName: moduleName,
            extension: getScriptExtension(moduleUrl.pathname, ".js"),
          };
        }
        if (this._httpTsModules.has(moduleName)) {
          return {
            resolvedFileName: moduleName,
            extension: getScriptExtension(moduleUrl.pathname, ".ts"),
          };
        }
        if (this._dtsMap.has(moduleName)) {
          return {
            resolvedFileName: this._dtsMap.get(moduleName),
            extension: ".d.ts",
          };
        }
        if (this._httpLibs.has(moduleName)) {
          return {
            resolvedFileName: moduleName,
            extension: ".d.ts",
          };
        }
        if (!this._fetchPromises.has(moduleName)) {
          const promise = isJsxImportSource || inImportMap || /^https?:\/\//.test(containingFile)
              || /\w@[~v^]?\d+(\.\d+){0,2}([&?/]|$)/.test(moduleUrl.pathname)
            ? cache.fetch(moduleUrl)
            : cache.query(moduleUrl);
          this._fetchPromises.set(
            moduleName,
            promise.then(async (res) => {
              if (!res) {
                // did not find the module in the cache
                this._unknownModules.add(moduleName);
                return;
              }
              if (res.ok) {
                const contentType = res.headers.get("content-type");
                const dts = res.headers.get("x-typescript-types");
                const resUrl = new URL(res.url);
                if (res.redirected) {
                  this._httpRedirects.push({ node: literal, url: res.url });
                }
                if (dts) {
                  const dtsRes = await cache.fetch(new URL(dts, res.url));
                  res.body?.cancel();
                  if (dtsRes.ok) {
                    this._httpLibs.set(dtsRes.url, await dtsRes.text());
                    this._dtsMap.set(moduleName, dtsRes.url);
                  }
                } else if (
                  /\.(c|m)?jsx?$/.test(resUrl.pathname)
                  || /^(application|text)\/(javascript|jsx)/.test(contentType)
                ) {
                  this._httpModules.set(moduleName, await res.text());
                } else if (
                  /\.(c|m)?tsx?$/.test(resUrl.pathname)
                  || /^(application|text)\/(typescript|tsx)/.test(contentType)
                ) {
                  if (/\.d\.(c|m)?ts$/.test(resUrl.pathname)) {
                    this._httpLibs.set(moduleName, await res.text());
                  } else {
                    this._httpTsModules.set(moduleName, await res.text());
                  }
                } else {
                  // not a javascript or typescript module
                  res.body?.cancel();
                  this._naModules.add(moduleName);
                }
              } else {
                res.body?.cancel();
                this._naModules.add(moduleName);
              }
              this._rollbackVersion(containingFile);
            }).finally(() => {
              this._fetchPromises.delete(moduleName);
              if (this._fetchPromises.size === 0) {
                this._refreshDiagnostics();
              }
            }),
          );
        }
      }
      // hide diagnostics for unresolved modules`
      return {
        resolvedFileName: specifier,
        extension: ".js",
      };
    }).map((resolvedModule) => {
      return { resolvedModule };
    });
  }

  // #endregion

  // #region language features

  async getSyntacticDiagnostics(fileName: string): Promise<Diagnostic[]> {
    const diagnostics = this._languageService.getSyntacticDiagnostics(fileName);
    return clearFiles(diagnostics);
  }

  async getSemanticDiagnostics(fileName: string): Promise<Diagnostic[]> {
    const diagnostics = this._languageService.getSemanticDiagnostics(fileName);
    return clearFiles(diagnostics);
  }

  async getSuggestionDiagnostics(fileName: string): Promise<Diagnostic[]> {
    const diagnostics = this._languageService.getSuggestionDiagnostics(fileName);
    const finDiagnostics = clearFiles(diagnostics);
    if (this._httpRedirects.length > 0) {
      this._httpRedirects.forEach(({ node, url }) => {
        finDiagnostics.push({
          file: { fileName },
          start: node.getStart(),
          length: node.getWidth(),
          code: 7000,
          category: ts.DiagnosticCategory.Message,
          messageText: `The module was redirected to ${url}`,
        });
      });
    }
    return finDiagnostics;
  }

  // async getCompilerOptionsDiagnostics(fileName: string): Promise<Diagnostic[]> {
  //   const diagnostics = this._languageService.getCompilerOptionsDiagnostics();
  //   return clearFiles(diagnostics);
  // }

  async getCompletionsAtPosition(fileName: string, position: number): Promise<ts.CompletionInfo | undefined> {
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
        if (
          !data
          || !isDts(data.fileName)
        ) {
          return true;
        }
        if (
          data.moduleSpecifier in this._importMap.imports
          || this._dtsMap.has(data.moduleSpecifier)
        ) {
          autoImports.add(data.exportName + " " + data.moduleSpecifier);
          return true;
        }
        const specifier = this._getSpecifierFromDts(data.fileName);
        if (
          specifier
          && !autoImports.has(data.exportName + " " + specifier)
        ) {
          autoImports.add(data.exportName + " " + specifier);
          return true;
        }
        return false;
      });
    }
    return completions;
  }

  async getCompletionEntryDetails(
    fileName: string,
    position: number,
    entryName: string,
    data?: ts.CompletionEntryData,
  ): Promise<ts.CompletionEntryDetails | undefined> {
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

  async getSignatureHelpItems(
    fileName: string,
    position: number,
    options: ts.SignatureHelpItemsOptions | undefined,
  ): Promise<ts.SignatureHelpItems | undefined> {
    return this._languageService.getSignatureHelpItems(
      fileName,
      position,
      options,
    );
  }

  async getQuickInfoAtPosition(fileName: string, position: number): Promise<ts.QuickInfo | undefined> {
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

  async getDocumentHighlights(
    fileName: string,
    position: number,
    filesToSearch: string[],
  ): Promise<ReadonlyArray<ts.DocumentHighlights> | undefined> {
    return this._languageService.getDocumentHighlights(
      fileName,
      position,
      filesToSearch,
    );
  }

  async getDefinitionAndBoundSpan(
    fileName: string,
    position: number,
  ): Promise<ts.DefinitionInfoAndBoundSpan | undefined> {
    return this._languageService.getDefinitionAndBoundSpan(fileName, position);
  }

  async getReferencesAtPosition(
    fileName: string,
    position: number,
  ): Promise<ts.ReferenceEntry[] | undefined> {
    return this._languageService.getReferencesAtPosition(fileName, position);
  }

  async getNavigationTree(fileName: string): Promise<ts.NavigationTree | undefined> {
    return this._languageService.getNavigationTree(fileName);
  }

  // async getFormattingEditsForDocument(
  //   fileName: string,
  //   formatOptions: ts.FormatCodeSettings,
  // ): Promise<ts.TextChange[]> {
  //   return this._languageService.getFormattingEditsForDocument(
  //     fileName,
  //     this._mergeFormatOptions(formatOptions),
  //   );
  // }

  async getFormattingEditsForRange(
    fileName: string,
    start: number,
    end: number,
    formatOptions: ts.FormatCodeSettings,
  ): Promise<ts.TextChange[]> {
    return this._languageService.getFormattingEditsForRange(
      fileName,
      start,
      end,
      this._mergeFormatOptions(formatOptions),
    );
  }

  async getFormattingEditsAfterKeystroke(
    fileName: string,
    postion: number,
    ch: string,
    formatOptions: ts.FormatCodeSettings,
  ): Promise<ts.TextChange[]> {
    return this._languageService.getFormattingEditsAfterKeystroke(
      fileName,
      postion,
      ch,
      this._mergeFormatOptions(formatOptions),
    );
  }

  async findRenameLocations(
    fileName: string,
    position: number,
    findInStrings: boolean,
    findInComments: boolean,
    providePrefixAndSuffixTextForRename: boolean,
  ): Promise<readonly ts.RenameLocation[] | undefined> {
    return this._languageService.findRenameLocations(
      fileName,
      position,
      findInStrings,
      findInComments,
      providePrefixAndSuffixTextForRename,
    );
  }

  async getLinkedEditingRangeAtPosition(
    fileName: string,
    position: number,
  ): Promise<ts.LinkedEditingInfo | undefined> {
    return this._languageService.getLinkedEditingRangeAtPosition(fileName, position);
  }

  async getRenameInfo(
    fileName: string,
    position: number,
    options: ts.UserPreferences,
  ): Promise<ts.RenameInfo> {
    return this._languageService.getRenameInfo(fileName, position, options);
  }

  // async getEmitOutput(fileName: string): Promise<ts.EmitOutput> {
  //   return this._languageService.getEmitOutput(fileName);
  // }

  async getCodeFixesAtPosition(
    fileName: string,
    start: number,
    end: number,
    errorCodes: number[],
    formatOptions: ts.FormatCodeSettings,
  ): Promise<ReadonlyArray<ts.CodeFixAction>> {
    let span = [start + 1, end - 1] as [number, number];
    // fix link span
    if (start === end && (this._httpRedirects.length > 0 || errorCodes.includes(2307))) {
      const a = this._languageService.getReferencesAtPosition(fileName, start);
      if (a && a.length > 0) {
        const b = a[0];
        span = [b.textSpan.start, b.textSpan.start + b.textSpan.length];
      }
    }
    const fixes: ts.CodeFixAction[] = [];
    if (this._httpRedirects.length > 0) {
      const i = this._httpRedirects.findIndex(({ node }) => {
        return node.getStart() === span[0] - 1 && node.getEnd() === span[1] + 1;
      });
      if (i >= 0) {
        const r = this._httpRedirects[i];
        const fixName = `Update module specifier to ${r.url}`;
        fixes.push({
          fixName,
          description: fixName,
          changes: [{
            fileName,
            textChanges: [{
              span: {
                start: r.node.getStart(),
                length: r.node.getWidth(),
              },
              newText: JSON.stringify(r.url),
            }],
          }],
          commands: [{
            id: "remove-http-redirect",
            title: "Remove http redirect",
            arguments: [i],
          }],
        });
      }
    }
    if (errorCodes.includes(2307)) {
      const model = this._getModel(fileName);
      const specifier = model.getValue().slice(...span);
      const importMapSrc = this._importMap.$src;
      if (this._unknownModules.has(specifier)) {
        const fixName = `Cache module from '${specifier}'`;
        fixes.push({
          fixName,
          description: fixName,
          changes: [],
          commands: [{
            id: "cache-http-module",
            title: "Try to cache the module from the network",
            arguments: [specifier, fileName],
          }],
        });
      } else if (/^@?\w[\w.-]*(\/|$)/.test(specifier) && importMapSrc) {
        const url = `https://esm.sh/${specifier}`;
        const res = await cache.fetch(url);
        if (res.ok && res.url.startsWith(url + "@")) {
          res.body?.cancel();
          const segments = new URL(res.url).pathname.split("/");
          const pkgNameWithVersion = segments[1].startsWith("@") ? segments.slice(1, 3).join("/") : segments[1];
          const pkgName = pkgNameWithVersion.slice(0, pkgNameWithVersion.lastIndexOf("@"));
          const fixName = `Add ${specifier}(https://esm.sh/${pkgNameWithVersion}) to import map`;
          fixes.push({
            fixName,
            description: fixName,
            changes: [],
            commands: [{
              id: "vfs.importmap.add_module",
              title: "Add module to import map",
              arguments: [importMapSrc, pkgName, `https://esm.sh/${pkgNameWithVersion}`],
            }],
          });
        }
      }
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

  async provideInlayHints(
    fileName: string,
    start: number,
    end: number,
  ): Promise<readonly ts.InlayHint[]> {
    const preferences: ts.UserPreferences = this._inlayHintsOptions ?? {};
    const span: ts.TextSpan = { start, length: end - start };
    try {
      return this._languageService.provideInlayHints(
        fileName,
        span,
        preferences,
      );
    } catch {
      return [];
    }
  }

  // async organizeImports(
  //   fileName: string,
  //   formatOptions: ts.FormatCodeSettings,
  // ): Promise<readonly ts.FileTextChanges[]> {
  //   try {
  //     return this._languageService.organizeImports(
  //       {
  //         type: "file",
  //         fileName,
  //         mode: ts.OrganizeImportsMode.SortAndCombine,
  //       },
  //       this._mergeFormatOptions(formatOptions),
  //       undefined,
  //     );
  //   } catch {
  //     return [];
  //   }
  // }

  // #endregion

  // #region language features as embedded language
  async doValidation(uri: string): Promise<lst.Diagnostic[]> {
    const document = this._getMirrorTextDocument(uri);
    if (!document) {
      return [];
    }
    const syntaxDiagnostics = await this.getSyntacticDiagnostics(uri);
    return syntaxDiagnostics.map(
      (diag: ts.Diagnostic): lst.Diagnostic => {
        return {
          range: convertRange(document, diag),
          severity: DiagnosticSeverity.Error,
          source: "javascript",
          message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
        };
      },
    );
  }

  async doComplete(uri: string, position: lst.Position): Promise<lst.CompletionList | null> {
    const document = this._getMirrorTextDocument(uri);
    if (!document) {
      return null;
    }
    const offset = document.offsetAt(position);
    const completions = await this.getCompletionsAtPosition(uri, offset);
    if (!completions) {
      return { isIncomplete: false, items: [] };
    }
    const replaceRange = convertRange(document, getWordAtText(document.getText(), offset, JS_WORD_REGEX));
    return {
      isIncomplete: false,
      items: completions.entries.map(entry => {
        // data used for resolving item details (see 'doResolve')
        const data = {
          languageId: "javascript",
          uri,
          offset: offset,
        };
        return {
          uri,
          position: position,
          label: entry.name,
          sortText: entry.sortText,
          kind: convertKind(entry.kind),
          textEdit: TextEdit.replace(replaceRange, entry.name),
          data,
        };
      }),
    };
  }

  async doFormat(
    uri: string,
    range: lst.Range | null,
    options: lst.FormattingOptions,
    docText?: string,
  ) {
  }

  async doHover(uri: string, position: lst.Position): Promise<lst.Hover | null> {
    const document = this._getMirrorTextDocument(uri);
    if (!document) {
      return null;
    }

    const info = await this.getQuickInfoAtPosition(uri, document.offsetAt(position));
    if (info) {
      const contents = ts.displayPartsToString(info.displayParts);
      const documentation = info.documentation?.map((part) => part.text).join("") ?? "";
      const tags = info.tags?.map((tag) => tagToString(tag)).join("  \n\n") ?? null;
      return {
        range: convertRange(document, info.textSpan),
        contents: [
          { value: contents, language: "typescript" },
          documentation + (tags ? "\n\n" + tags : ""),
        ],
      };
    }
    return null;
  }

  async doRename(uri: string, position: lst.Position, newName: string): Promise<lst.WorkspaceEdit | null> {
    const document = this._getMirrorTextDocument(uri);
    if (!document) {
      return null;
    }

    const documentPosition = document.offsetAt(position);
    // const { canRename } = this._languageService.getRenameInfo(uri, documentPosition, {});
    // if (!canRename) {
    //   return null;
    // }

    const renameInfos = this._languageService.findRenameLocations(uri, documentPosition, false, false, {});
    const edits: lst.TextEdit[] = [];
    renameInfos?.map(renameInfo => {
      if (renameInfo.fileName === uri) {
        edits.push({
          range: convertRange(document, renameInfo.textSpan),
          newText: newName,
        });
      }
    });
    return {
      changes: { [uri]: edits },
    };
  }

  async getFoldingRanges(uri: string): Promise<lst.FoldingRange[]> {
    const document = this._getMirrorTextDocument(uri);
    if (!document) {
      return [];
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

  async findDocumentHighlights(uri: string, position: lst.Position): Promise<lst.DocumentHighlight[]> {
    const document = this._getMirrorTextDocument(uri);
    if (!document) {
      return [];
    }
    const highlights = this._languageService.getDocumentHighlights(uri, document.offsetAt(position), [uri]);
    const out: lst.DocumentHighlight[] = [];
    for (const entry of highlights || []) {
      for (const highlight of entry.highlightSpans) {
        out.push({
          range: convertRange(document, highlight.textSpan),
          kind: highlight.kind === "writtenReference"
            ? DocumentHighlightKind.Write
            : DocumentHighlightKind.Text,
        });
      }
    }
    return out;
  }

  async findDefinition(
    uri: string,
    position: lst.Position,
  ): Promise<(lst.Location & { originSelectionRange: lst.Range })[] | null> {
    const document = this._getMirrorTextDocument(uri);
    if (!document) {
      return null;
    }
    const res = this._languageService.getDefinitionAndBoundSpan(uri, document.offsetAt(position));
    if (res) {
      const { definitions, textSpan } = res;
      return definitions.map(d => {
        const doc = d.fileName === uri ? document : this._getMirrorTextDocument(d.fileName);
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

  // #endregion

  // #region methods used by the host

  async cacheHttpModule(specifier: string, containingFile: string): Promise<void> {
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

  async removeHttpRedirect(index: number): Promise<void> {
    this._httpRedirects.splice(index, 1);
    this._refreshDiagnostics();
  }

  async updateCompilerOptions({
    compilerOptions,
    importMap,
    types,
  }: {
    compilerOptions?: ts.CompilerOptions;
    importMap?: ImportMap;
    types?: Record<string, VersionedContent>;
  }): Promise<void> {
    if (compilerOptions) {
      this._compilerOptions = compilerOptions;
    }
    if (importMap) {
      this._importMap = importMap;
      this._importMapVersion++;
      this._isBlankImportMap = isBlank(importMap);
    }
    if (types) {
      this._types = types;
    }
  }

  // #endregion

  // #region private methods

  private _refreshDiagnostics(): void {
    if (this._refreshDiagnosticsTimer !== null) {
      return;
    }
    this._refreshDiagnosticsTimer = setTimeout(() => {
      this._refreshDiagnosticsTimer = null;
      this._ctx.host.refreshDiagnostics();
    }, 500);
  }

  /** rollback the version to force reinvoke `resolveModuleNameLiterals` method. */
  private _rollbackVersion(fileName: string) {
    const model = this._getModel(fileName);
    if (model) {
      // @ts-expect-error private field
      model._versionId--;
    }
  }

  private _fileExists(fileName: string): boolean {
    let models = this._ctx.getMirrorModels();
    for (let i = 0; i < models.length; i++) {
      const uri = models[i].uri;
      if (uri.toString() === fileName || uri.toString(true) === fileName) {
        return true;
      }
    }
    return (
      fileName in this._libs
      || `lib.${fileName}.d.ts` in this._libs
      || fileName in this._types
      || this._httpLibs.has(fileName)
      || this._httpModules.has(fileName)
      || this._httpTsModules.has(fileName)
    );
  }

  private _getScriptText(fileName: string): string | undefined {
    let model = this._getModel(fileName);
    if (model) {
      return model.getValue();
    }
    return this._libs[fileName]
      ?? this._libs[`lib.${fileName}.d.ts`]
      ?? this._types[fileName]?.content
      ?? this._httpLibs.get(fileName)
      ?? this._httpModules.get(fileName)
      ?? this._httpTsModules.get(fileName);
  }

  private _getMirrorTextDocument(uri: string): lst.TextDocument | null {
    for (const model of this._ctx.getMirrorModels()) {
      if (model.uri.toString() === uri) {
        return TextDocument.create(
          uri,
          "javascript",
          model.version,
          model.getValue(),
        );
      }
    }
    return null;
  }

  private _getModel(fileName: string): monacoNS.worker.IMirrorModel | null {
    let models = this._ctx.getMirrorModels();
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

  private _getJsxImportUrl(): string | null {
    let runtimePath = "/jsx-runtime";
    if (this._compilerOptions.jsx === ts.JsxEmit.ReactJSXDev) {
      runtimePath = "/jsx-dev-runtime";
    }
    if (this._compilerOptions.jsxImportSource) {
      const url = new URL(this._compilerOptions.jsxImportSource + runtimePath);
      return url.href;
    } else if (!this._isBlankImportMap) {
      const url = new URL(this._importMap.imports["@jsxImportSource"] + runtimePath);
      return url.href;
    }
    return null;
  }

  private _mergeFormatOptions(
    formatOptions: ts.FormatCodeSettings,
  ): ts.FormatCodeSettings {
    return {
      ...this._formatOptions,
      ...formatOptions,
    };
  }

  // #endregion
}

function getScriptExtension(
  url: URL | string,
  defaultExt = ".js",
): string | null {
  const pathname = typeof url === "string" ? new URL(url, "file:///").pathname : url.pathname;
  const fileName = pathname.substring(pathname.lastIndexOf("/") + 1);
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) {
    return defaultExt ?? null;
  }
  const ext = fileName.substring(dotIndex + 1);
  switch (ext) {
    case "ts":
      return fileName.endsWith(".d.ts") ? ".d.ts" : ".ts";
    case "mts":
      return fileName.endsWith(".d.mts") ? ".d.mts" : ".mts";
    case "cts":
      return fileName.endsWith(".d.cts") ? ".d.cts" : ".cts";
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

function isDts(fileName: string): boolean {
  return fileName.endsWith(".d.ts") || fileName.endsWith(".d.mts") || fileName.endsWith(".d.cts");
}

// Clear the `file` field, which cannot be JSON stringified because it
// contains cyclic data structures, except for the `fileName`
// property.
// Do a deep clone so we don't mutate the ts.Diagnostic object (see https://github.com/microsoft/monaco-editor/issues/2392)
function clearFiles(tsDiagnostics: ts.Diagnostic[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const tsDiagnostic of tsDiagnostics) {
    const diagnostic: Diagnostic = {
      ...tsDiagnostic,
      file: tsDiagnostic.file ? { fileName: tsDiagnostic.file.fileName } : undefined,
    };
    if (tsDiagnostic.relatedInformation) {
      diagnostic.relatedInformation = [];
      for (const tsRelatedDiagnostic of tsDiagnostic.relatedInformation) {
        const relatedDiagnostic: DiagnosticRelatedInformation = {
          ...tsRelatedDiagnostic,
        };
        relatedDiagnostic.file = relatedDiagnostic.file ? { fileName: relatedDiagnostic.file.fileName } : undefined;
        diagnostic.relatedInformation.push(relatedDiagnostic);
      }
    }
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

const enum Kind {
  alias = "alias",
  callSignature = "call",
  class = "class",
  const = "const",
  constructorImplementation = "constructor",
  constructSignature = "construct",
  directory = "directory",
  enum = "enum",
  enumMember = "enum member",
  externalModuleName = "external module name",
  function = "function",
  indexSignature = "index",
  interface = "interface",
  keyword = "keyword",
  let = "let",
  localFunction = "local function",
  localVariable = "local var",
  method = "method",
  memberGetAccessor = "getter",
  memberSetAccessor = "setter",
  memberVariable = "property",
  module = "module",
  primitiveType = "primitive type",
  script = "script",
  type = "type",
  variable = "var",
  warning = "warning",
  string = "string",
  parameter = "parameter",
  typeParameter = "type parameter",
}

function convertKind(kind: string): lst.CompletionItemKind {
  switch (kind) {
    case Kind.primitiveType:
    case Kind.keyword:
      return CompletionItemKind.Keyword;

    case Kind.const:
    case Kind.let:
    case Kind.variable:
    case Kind.localVariable:
    case Kind.alias:
    case Kind.parameter:
      return CompletionItemKind.Variable;

    case Kind.memberVariable:
    case Kind.memberGetAccessor:
    case Kind.memberSetAccessor:
      return CompletionItemKind.Field;

    case Kind.function:
    case Kind.localFunction:
      return CompletionItemKind.Function;

    case Kind.method:
    case Kind.constructSignature:
    case Kind.callSignature:
    case Kind.indexSignature:
      return CompletionItemKind.Method;

    case Kind.enum:
      return CompletionItemKind.Enum;

    case Kind.enumMember:
      return CompletionItemKind.EnumMember;

    case Kind.module:
    case Kind.externalModuleName:
      return CompletionItemKind.Module;

    case Kind.class:
    case Kind.type:
      return CompletionItemKind.Class;

    case Kind.interface:
      return CompletionItemKind.Interface;

    case Kind.warning:
      return CompletionItemKind.Text;

    case Kind.script:
      return CompletionItemKind.File;

    case Kind.directory:
      return CompletionItemKind.Folder;

    case Kind.string:
      return CompletionItemKind.Constant;

    default:
      return CompletionItemKind.Property;
  }
}

function convertRange(
  document: lst.TextDocument,
  span: { start: number | undefined; length: number | undefined },
): lst.Range {
  if (typeof span.start === "undefined") {
    const pos = document.positionAt(0);
    return Range.create(pos, pos);
  }
  const startPosition = document.positionAt(span.start);
  const endPosition = document.positionAt(span.start + (span.length || 0));
  return Range.create(startPosition, endPosition);
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

const JS_WORD_REGEX = /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g;

function getWordAtText(text: string, offset: number, wordDefinition: RegExp): { start: number; length: number } {
  let lineStart = offset;
  while (lineStart > 0 && !isNewlineCharacter(text.charCodeAt(lineStart - 1))) {
    lineStart--;
  }
  const offsetInLine = offset - lineStart;
  const lineText = text.slice(lineStart);

  // make a copy of the regex as to not keep the state
  const flags = wordDefinition.ignoreCase ? "gi" : "g";
  wordDefinition = new RegExp(wordDefinition.source, flags);

  let match = wordDefinition.exec(lineText);
  while (match && match.index + match[0].length < offsetInLine) {
    match = wordDefinition.exec(lineText);
  }
  if (match && match.index <= offsetInLine) {
    return { start: match.index + lineStart, length: match[0].length };
  }

  return { start: offset, length: 0 };
}

function isNewlineCharacter(charCode: number) {
  return charCode === 10 || charCode === 13;
}

// ! external module, don't remove the `.js` extension
import { initializeWorker } from "../../editor-worker.js";
initializeWorker(TypeScriptWorker);
