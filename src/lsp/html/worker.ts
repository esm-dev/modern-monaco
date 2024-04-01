/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) X. <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type monacoNS from "monaco-editor-core";
import type * as lst from "vscode-languageserver-types";
import * as htmlService from "vscode-html-languageservice";
import { initializeWorker } from "../../editor-worker.js";
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

export interface Settings {
  /**
   * Settings for the HTML formatter.
   */
  readonly format?: htmlService.HTMLFormatConfiguration;
  /**
   * Code completion settings.
   */
  readonly suggest?: htmlService.CompletionConfiguration;
}

export interface CreateData {
  languageId: string;
  settings: Settings;
  data?: HTMLDataConfiguration;
}

export class HTMLWorker {
  private _ctx: monacoNS.worker.IWorkerContext;
  private _languageService: htmlService.LanguageService;
  private _languageSettings: Settings;
  private _languageId: string;

  constructor(ctx: monacoNS.worker.IWorkerContext, createData: CreateData) {
    const data = createData.data;
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
    this._languageSettings = createData.settings;
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
    const rsls = rs.getEmbeddedLanguages();
    if (rsls.length > 0) {
      return {
        $embedded: {
          languageIds: rsls,
          origin: diagnostic,
        },
      } as any;
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
      return { $embedded: rsl } as any;
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
      return { $embedded: rsl } as any;
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
    const edits = this._languageService.format(document, formatRange, formattingOptions);

    // add last newline if needed
    if (this._languageSettings.format?.endWithNewline) {
      const text = document.getText();
      edits.push({
        range: {
          start: document.positionAt(text.length),
          end: document.positionAt(text.length),
        },
        newText: "\n",
      });
    }

    // const rs = getDocumentRegions(this._languageService, document);
    // const mark: Record<string, string> = {};
    // for (const { attributeValue, languageId, start, end } of rs.regions) {
    //   if (!attributeValue && (languageId === "importmap" || languageId === "javascript")) {
    //     mark[languageId] = document.getText().substring(start, end);
    //   }
    // }
    // const rsls = Object.keys(mark);
    // if (rsls.length > 0) {
    //   return {
    //     $embedded: {
    //       languageIds: rsls,
    //       data: Object.values(mark),
    //       origin: edits,
    //     },
    //   } as any;
    // }

    return edits;
  }

  async doRename(uri: string, position: lst.Position, newName: string): Promise<lst.WorkspaceEdit | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    const rsl = rs.getEmbeddedLanguageAtPosition(position);
    if (rsl) {
      return { $embedded: rsl } as any;
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
      return { $embedded: rsl } as any;
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
      return { $embedded: rsl } as any;
    }
    return null;
  }

  async findDocumentLinks(uri: string): Promise<lst.DocumentLink[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    return this._languageService.findDocumentLinks(document, null!);
  }

  async findDocumentSymbols(uri: string): Promise<lst.SymbolInformation[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const htmlDocument = this._languageService.parseHTMLDocument(document);
    return this._languageService.findDocumentSymbols(
      document,
      htmlDocument,
    );
  }

  async getFoldingRanges(uri: string, context?: { rangeLimit?: number }): Promise<lst.FoldingRange[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const ranges = this._languageService.getFoldingRanges(document, context);
    const rs = getDocumentRegions(this._languageService, document);
    const rsls = rs.getEmbeddedLanguages(true);
    if (rsls.length > 0) {
      return {
        $embedded: {
          languageIds: rsls,
          origin: ranges,
        },
      } as any;
    }
    return ranges;
  }

  async getSelectionRanges(uri: string, positions: lst.Position[]): Promise<lst.SelectionRange[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    return this._languageService.getSelectionRanges(document, positions);
  }

  async findDocumentColors(uri: string): Promise<lst.ColorInformation[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    if (rs.hasEmbeddedLanguage("css")) {
      return { $embedded: "css" } as any;
    }
    return null;
  }

  async getColorPresentations(uri: string, color: lst.Color, range: lst.Range): Promise<lst.ColorPresentation[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    if (rs.hasEmbeddedLanguage("css")) {
      return { $embedded: "css" } as any;
    }
    return null;
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

initializeWorker(HTMLWorker);
