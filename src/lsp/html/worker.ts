/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) X. <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type monacoNS from "monaco-editor-core";
import type * as lst from "vscode-languageserver-types";
import * as htmlService from "vscode-html-languageservice";
import { getDocumentRegions } from "./embedded-support";

export interface HTMLDataConfiguration {
  /**
   * Defines whether the standard CSS properties, at-directives, pseudoClasses and pseudoElements are shown.
   */
  useDefaultDataProvider?: boolean;
  /**
   * Provides a set of custom data providers.
   */
  dataProviders?: { [providerId: string]: htmlService.HTMLDataV1 };
}

export interface Options {
  /**
   * Settings for the HTML formatter.
   */
  readonly format?: htmlService.HTMLFormatConfiguration;
  /**
   * Code completion settings.
   */
  readonly suggest?: htmlService.CompletionConfiguration;
  /**
   * Configures the HTML data types known by the HTML langauge service.
   */
  readonly data?: HTMLDataConfiguration;
}

export interface CreateData {
  languageId: string;
  options: Options;
}

export interface Host {
  redirectLSPRequest<T>(langaugeId: string, method: string, uri: string, ...args: any[]): Promise<T>;
}

export class HTMLWorker {
  private _ctx: monacoNS.worker.IWorkerContext<Host>;
  private _languageService: htmlService.LanguageService;
  private _languageSettings: Options;
  private _languageId: string;

  constructor(ctx: monacoNS.worker.IWorkerContext<Host>, createData: CreateData) {
    const data = createData.options.data;
    const useDefaultDataProvider = data?.useDefaultDataProvider;
    const customDataProviders: htmlService.IHTMLDataProvider[] = [];
    if (data?.dataProviders) {
      for (const id in data.dataProviders) {
        customDataProviders.push(
          htmlService.newHTMLDataProvider(id, data.dataProviders[id]),
        );
      }
    }
    this._ctx = ctx;
    this._languageSettings = createData.options;
    this._languageId = createData.languageId;
    this._languageService = htmlService.getLanguageService({
      useDefaultDataProvider,
      customDataProviders,
    });
  }

  async doValidation(uri: string): Promise<lst.Diagnostic[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    const diagnostic: lst.Diagnostic[] = [];
    const rs = getDocumentRegions(this._languageService, document);
    if (rs.hasEmbeddedLanguage("importmap")) {
      const imr = rs.regions.find((region) => region.languageId === "importmap")!;
      const addDiagnostic = (r: { start: number; end: number }) =>
        diagnostic.push({
          severity: 1, // Error
          range: {
            start: document.positionAt(r.start),
            end: document.positionAt(r.end),
          },
          message: "Scripts are not allowed before the import map.",
          source: "html",
        });
      for (const script of rs.importedScripts) {
        if (script.end < imr.start) {
          addDiagnostic(script);
        } else {
          break;
        }
      }
      for (const r of rs.regions) {
        if (r.languageId === "javascript" && r.end < imr.start) {
          addDiagnostic(r);
        } else {
          break;
        }
      }
    }
    for (const rsl of rs.getEmbeddedLanguages()) {
      const ret = await this._ctx.host.redirectLSPRequest(
        rsl,
        "doValidation",
        uri,
      );
      // console.log(rsl, ret);
      if (Array.isArray(ret) && ret.length > 0) {
        diagnostic.push(...ret);
      }
    }
    return diagnostic;
  }

  async doComplete(uri: string, position: lst.Position): Promise<lst.CompletionList | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    const rsl = rs.getEmbeddedLanguageAtPosition(position);
    if (rsl) {
      return await this._ctx.host.redirectLSPRequest(rsl, "doComplete", uri, position) ?? null;
    }
    const htmlDocument = this._languageService.parseHTMLDocument(document);
    return this._languageService.doComplete(
      document,
      position,
      htmlDocument,
      this._languageSettings && this._languageSettings.suggest,
    );
  }

  async doHover(uri: string, position: lst.Position): Promise<lst.Hover | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    const rsl = rs.getEmbeddedLanguageAtPosition(position);
    if (rsl) {
      return await this._ctx.host.redirectLSPRequest(rsl, "doHover", uri, position) ?? null;
    }
    const htmlDocument = this._languageService.parseHTMLDocument(document);
    return this._languageService.doHover(document, position, htmlDocument);
  }

  async doFormat(uri: string, formatRange: lst.Range, options: lst.FormattingOptions): Promise<lst.TextEdit[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }

    const contentUnformatted = this._languageSettings.format?.contentUnformatted ?? "";
    const formattingOptions = {
      ...this._languageSettings.format,
      ...options,
      // remove last newline to allow embedded css to be formatted with newline
      endWithNewline: false,
      // unformat `<script>` tag
      contentUnformatted: contentUnformatted + ", script",
    };
    const htmlEdits = this._languageService.format(document, formatRange, formattingOptions);

    for (const region of getDocumentRegions(this._languageService, document).regions) {
      if (!region.attributeValue && region.languageId === "importmap") {
        const regionText = document.getText().substring(region.start, region.end);
        const regionDoc = htmlService.TextDocument.create(
          uri + "#" + region.languageId,
          region.languageId,
          0,
          regionText,
        );
        try {
          const edits = await this._ctx.host.redirectLSPRequest(
            region.languageId,
            "doFormat",
            uri,
            formatRange,
            options,
            regionText,
          );
          if (Array.isArray(edits)) {
            const formatted = htmlService.TextDocument.applyEdits(regionDoc, edits);
            const indent = "  ";
            htmlEdits.push({
              range: {
                start: document.positionAt(region.start),
                end: document.positionAt(region.end),
              },
              newText: [indent, ...formatted.split("\n").map(l => indent + l), indent].join("\n"),
            });
          }
        } catch (error) {
          // ignore
        }
      }
    }

    // add last newline if needed
    if (this._languageSettings.format?.endWithNewline) {
      const text = document.getText();
      htmlEdits.push({
        range: {
          start: document.positionAt(text.length),
          end: document.positionAt(text.length),
        },
        newText: "\n",
      });
    }

    return htmlEdits;
  }

  async doRename(uri: string, position: lst.Position, newName: string): Promise<lst.WorkspaceEdit | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    const rsl = rs.getEmbeddedLanguageAtPosition(position);
    if (rsl) {
      const ret: lst.WorkspaceEdit | undefined = await this._ctx.host.redirectLSPRequest(
        rsl,
        "doRename",
        uri,
        position,
        newName,
      );
      console.log(rsl, ret);
      if (!ret || !ret.changes) {
        return null;
      }
      ret.changes = Object.fromEntries([[uri, Object.values(ret.changes)[0]]]);
      return ret;
    }
    const htmlDocument = this._languageService.parseHTMLDocument(document);
    return this._languageService.doRename(
      document,
      position,
      newName,
      htmlDocument,
    );
  }

  async findDocumentHighlights(uri: string, position: lst.Position): Promise<lst.DocumentHighlight[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    const rs = getDocumentRegions(this._languageService, document);
    const rsl = rs.getEmbeddedLanguageAtPosition(position);
    if (rsl) {
      return await this._ctx.host.redirectLSPRequest(rsl, "findDocumentHighlights", uri, position) ?? null;
    }
    const htmlDocument = this._languageService.parseHTMLDocument(document);
    return this._languageService.findDocumentHighlights(
      document,
      position,
      htmlDocument,
    );
  }

  async findDefinition(
    uri: string,
    position: lst.Position,
  ): Promise<(lst.Location & { originSelectionRange?: lst.Range })[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    const rsl = rs.getEmbeddedLanguageAtPosition(position);
    if (rsl) {
      return await this._ctx.host.redirectLSPRequest(
        rsl,
        "findDefinition",
        uri,
        position,
      ) ?? null;
    }
    return null;
  }

  async findDocumentLinks(uri: string): Promise<lst.DocumentLink[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    return this._languageService.findDocumentLinks(
      document,
      null!, /*TODO@aeschli*/
    );
  }

  async findDocumentSymbols(uri: string): Promise<lst.SymbolInformation[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    const htmlDocument = this._languageService.parseHTMLDocument(document);
    return this._languageService.findDocumentSymbols(
      document,
      htmlDocument,
    );
  }

  async getFoldingRanges(uri: string, context?: { rangeLimit?: number }): Promise<lst.FoldingRange[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    const ranges: lst.FoldingRange[] = [];
    const rs = getDocumentRegions(this._languageService, document);
    for (const rsl of rs.getEmbeddedLanguages(true)) {
      const range = await this._ctx.host.redirectLSPRequest(rsl, "getFoldingRanges", uri, context);
      if (Array.isArray(range)) {
        ranges.push(...range);
      }
    }
    return ranges.concat(this._languageService.getFoldingRanges(document, context));
  }

  async getSelectionRanges(uri: string, positions: lst.Position[]): Promise<lst.SelectionRange[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    return this._languageService.getSelectionRanges(document, positions);
  }

  async findDocumentColors(uri: string): Promise<lst.ColorInformation[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    const rs = getDocumentRegions(this._languageService, document);
    if (rs.hasEmbeddedLanguage("css")) {
      return await this._ctx.host.redirectLSPRequest("css", "findDocumentColors", uri) ?? [];
    }
    return [];
  }

  async getColorPresentations(uri: string, color: lst.Color, range: lst.Range): Promise<lst.ColorPresentation[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    const rs = getDocumentRegions(this._languageService, document);
    if (rs.hasEmbeddedLanguage("css")) {
      return await this._ctx.host.redirectLSPRequest("css", "getColorPresentations", uri, color, range) ?? [];
    }
    return [];
  }

  async getEmbeddedDocument(uri: string, languageId: string): Promise<{ content: string } | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    const content = rs.getEmbeddedDocument(languageId);
    if (content) {
      return { content };
    }
    return null;
  }

  private _getTextDocument(uri: string): htmlService.TextDocument | null {
    for (const model of this._ctx.getMirrorModels()) {
      if (model.uri.toString() === uri) {
        return htmlService.TextDocument.create(
          uri,
          this._languageId,
          model.version,
          model.getValue(),
        );
      }
    }
    return null;
  }
}

// ! external module, don't remove the `.js` extension
import { initializeWorker } from "../../editor-worker.js";
initializeWorker(HTMLWorker);
