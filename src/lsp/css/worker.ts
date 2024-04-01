/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) X. <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type monacoNS from "monaco-editor-core";
import * as cssService from "vscode-css-languageservice";
import { initializeWorker } from "../../editor-worker.js";

export interface CSSDataConfiguration {
  /**
   * Defines whether the standard CSS properties, at-directives, pseudoClasses and pseudoElements are shown.
   */
  useDefaultDataProvider?: boolean;
  /**
   * Provides a set of custom data providers.
   */
  dataProviders?: { [providerId: string]: cssService.CSSDataV1 };
}

export interface Options {
  /**
   * Configures the CSS data types known by the langauge service.
   */
  readonly data?: CSSDataConfiguration;
  /**
   * Settings for the CSS formatter.
   */
  readonly format?: cssService.CSSFormatConfiguration;
}

export interface CreateData {
  options: Options;
}

export class CSSWorker {
  private _ctx: monacoNS.worker.IWorkerContext;
  private _languageSettings: Options;
  private _languageService: cssService.LanguageService;
  private _documentCache = new Map<string, [number, cssService.TextDocument, cssService.Stylesheet | undefined]>();

  constructor(ctx: monacoNS.worker.IWorkerContext, createData: CreateData) {
    const data = createData.options.data;
    const customDataProviders: cssService.ICSSDataProvider[] = [];
    if (data?.dataProviders) {
      for (const id in data.dataProviders) {
        customDataProviders.push(cssService.newCSSDataProvider(data.dataProviders[id]));
      }
    }
    const lsOptions: cssService.LanguageServiceOptions = {
      useDefaultDataProvider: data?.useDefaultDataProvider,
      customDataProviders,
    };
    this._ctx = ctx;
    this._languageSettings = createData.options;
    this._languageService = cssService.getCSSLanguageService(lsOptions);
  }

  async doValidation(uri: string): Promise<cssService.Diagnostic[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this._getStylesheet(document);
    return this._languageService.doValidation(document, stylesheet);
  }

  async doComplete(uri: string, position: cssService.Position): Promise<cssService.CompletionList | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this._getStylesheet(document);
    return this._languageService.doComplete(document, position, stylesheet);
  }

  async doHover(uri: string, position: cssService.Position): Promise<cssService.Hover | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this._getStylesheet(document);
    return this._languageService.doHover(document, position, stylesheet);
  }

  async doCodeActions(
    uri: string,
    range: cssService.Range,
    context: cssService.CodeActionContext,
  ): Promise<cssService.Command[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this._getStylesheet(document);
    return this._languageService.doCodeActions(document, range, context, stylesheet);
  }

  async doRename(
    uri: string,
    position: cssService.Position,
    newName: string,
  ): Promise<cssService.WorkspaceEdit | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this._getStylesheet(document);
    return this._languageService.doRename(document, position, newName, stylesheet);
  }

  async doFormat(
    uri: string,
    range: cssService.Range | null,
    options: cssService.CSSFormatConfiguration,
  ): Promise<cssService.TextEdit[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const settings = { ...this._languageSettings.format, ...options };
    return this._languageService.format(document, range!, settings);
  }

  async findDocumentSymbols(uri: string): Promise<cssService.SymbolInformation[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this._getStylesheet(document);
    return this._languageService.findDocumentSymbols(document, stylesheet);
  }

  async findDefinition(uri: string, position: cssService.Position): Promise<cssService.Location[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this._getStylesheet(document);
    const definition = this._languageService.findDefinition(document, position, stylesheet);
    if (definition) {
      return [definition];
    }
    return null;
  }

  async findReferences(uri: string, position: cssService.Position): Promise<cssService.Location[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this._getStylesheet(document);
    return this._languageService.findReferences(document, position, stylesheet);
  }

  async findDocumentHighlights(
    uri: string,
    position: cssService.Position,
  ): Promise<cssService.DocumentHighlight[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this._getStylesheet(document);
    return this._languageService.findDocumentHighlights(document, position, stylesheet);
  }

  async findDocumentColors(uri: string): Promise<cssService.ColorInformation[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this._getStylesheet(document);
    return this._languageService.findDocumentColors(document, stylesheet);
  }

  async getColorPresentations(
    uri: string,
    color: cssService.Color,
    range: cssService.Range,
  ): Promise<cssService.ColorPresentation[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this._getStylesheet(document);
    return this._languageService.getColorPresentations(document, stylesheet, color, range);
  }

  async getFoldingRanges(uri: string, context?: { rangeLimit?: number }): Promise<cssService.FoldingRange[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    return this._languageService.getFoldingRanges(document, context);
  }

  async getSelectionRanges(uri: string, positions: cssService.Position[]): Promise<cssService.SelectionRange[] | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this._getStylesheet(document);
    return this._languageService.getSelectionRanges(document, positions, stylesheet);
  }

  async onDocumentRemoved(uri: string): Promise<void> {
    this._documentCache.delete(uri);
  }

  private _getTextDocument(uri: string): cssService.TextDocument | null {
    for (const model of this._ctx.getMirrorModels()) {
      if (model.uri.toString() === uri) {
        const cached = this._documentCache.get(uri);
        if (cached && cached[0] === model.version) {
          return cached[1];
        }
        const document = cssService.TextDocument.create(uri, "css", model.version, model.getValue());
        this._documentCache.set(uri, [model.version, document, undefined]);
        return document;
      }
    }
    return null;
  }

  private _getStylesheet(document: cssService.TextDocument): cssService.Stylesheet | null {
    const { uri, version } = document;
    const cached = this._documentCache.get(uri);
    if (cached && cached[0] === version && cached[2]) {
      return cached[2];
    }
    const stylesheet = this._languageService.parseStylesheet(document);
    this._documentCache.set(uri, [version, document, stylesheet]);
    return stylesheet;
  }
}

initializeWorker(CSSWorker);
