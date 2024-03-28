/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) X. <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type monacoNS from "monaco-editor-core";
import * as jsonService from "vscode-json-languageservice";

// ! external module, don't remove the `.js` extension
import { cache } from "../../cache.js";
import { initializeWorker } from "../../editor-worker.js";

export interface Options {
  /** Configures the CSS data types known by the langauge service. */
  readonly settings?: jsonService.LanguageSettings & jsonService.DocumentLanguageSettings;
  /** Settings for the CSS formatter. */
  readonly format?: jsonService.FormattingOptions;
}

export interface CreateData {
  languageId: string;
  options: Options;
}

export class JSONWorker {
  private _ctx: monacoNS.worker.IWorkerContext;
  private _languageService: jsonService.LanguageService;

  constructor(ctx: monacoNS.worker.IWorkerContext, createData: CreateData) {
    this._ctx = ctx;
    this._languageService = jsonService.getLanguageService({
      workspaceContext: {
        resolveRelativePath: (relativePath: string, resource: string) => {
          const url = new URL(relativePath, resource);
          return url.href;
        },
      },
      schemaRequestService: (url) => cache.fetch(url).then((res) => res.text()),
      clientCapabilities: jsonService.ClientCapabilities.LATEST,
    });
    this._languageService.configure(createData.options.settings ?? {});
  }

  async doValidation(uri: string): Promise<jsonService.Diagnostic[]> {
    let document = this._getTextDocument(uri);
    if (document) {
      let jsonDocument = this._languageService.parseJSONDocument(document);
      return this._languageService.doValidation(document, jsonDocument);
    }
    return [];
  }

  async doComplete(
    uri: string,
    position: jsonService.Position,
  ): Promise<jsonService.CompletionList | null> {
    let document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    let jsonDocument = this._languageService.parseJSONDocument(document);
    return this._languageService.doComplete(document, position, jsonDocument);
  }

  async doHover(
    uri: string,
    position: jsonService.Position,
  ): Promise<jsonService.Hover | null> {
    let document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    let jsonDocument = this._languageService.parseJSONDocument(document);
    return this._languageService.doHover(document, position, jsonDocument);
  }

  async doFormat(
    uri: string,
    range: jsonService.Range | null,
    options: jsonService.FormattingOptions,
    docText?: string,
  ): Promise<jsonService.TextEdit[]> {
    const document = docText
      ? jsonService.TextDocument.create(uri, "json", 0, docText)
      : this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    return this._languageService.format(
      document,
      range!, /* TODO */
      options,
    );
  }

  async findDocumentSymbols(
    uri: string,
  ): Promise<jsonService.DocumentSymbol[]> {
    let document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    let jsonDocument = this._languageService.parseJSONDocument(document);
    let symbols = this._languageService.findDocumentSymbols2(
      document,
      jsonDocument,
    );
    return Promise.resolve(symbols);
  }

  async findDocumentColors(
    uri: string,
  ): Promise<jsonService.ColorInformation[]> {
    let document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    let jsonDocument = this._languageService.parseJSONDocument(document);
    let colorSymbols = this._languageService.findDocumentColors(
      document,
      jsonDocument,
    );
    return Promise.resolve(colorSymbols);
  }

  async getColorPresentations(
    uri: string,
    color: jsonService.Color,
    range: jsonService.Range,
  ): Promise<jsonService.ColorPresentation[]> {
    let document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    let jsonDocument = this._languageService.parseJSONDocument(document);
    let colorPresentations = this._languageService.getColorPresentations(
      document,
      jsonDocument,
      color,
      range,
    );
    return Promise.resolve(colorPresentations);
  }

  async getFoldingRanges(
    uri: string,
    context?: { rangeLimit?: number },
  ): Promise<jsonService.FoldingRange[]> {
    let document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    let ranges = this._languageService.getFoldingRanges(document, context);
    return Promise.resolve(ranges);
  }

  async getSelectionRanges(
    uri: string,
    positions: jsonService.Position[],
  ): Promise<jsonService.SelectionRange[]> {
    let document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    let jsonDocument = this._languageService.parseJSONDocument(document);
    let ranges = this._languageService.getSelectionRanges(
      document,
      positions,
      jsonDocument,
    );
    return Promise.resolve(ranges);
  }

  async resetSchema(uri: string): Promise<boolean> {
    return Promise.resolve(this._languageService.resetSchema(uri));
  }

  // async doResolve(
  //   item: jsonService.CompletionItem,
  // ): Promise<jsonService.CompletionItem> {
  //   return this._languageService.doResolve(item);
  // }

  // async parseJSONDocument(
  //   uri: string,
  // ): Promise<jsonService.JSONDocument | null> {
  //   let document = this._getTextDocument(uri);
  //   if (!document) {
  //     return null;
  //   }
  //   let jsonDocument = this._languageService.parseJSONDocument(document);
  //   return Promise.resolve(jsonDocument);
  // }

  // async getMatchingSchemas(uri: string): Promise<jsonService.MatchingSchema[]> {
  //   let document = this._getTextDocument(uri);
  //   if (!document) {
  //     return [];
  //   }
  //   let jsonDocument = this._languageService.parseJSONDocument(document);
  //   return Promise.resolve(
  //     this._languageService.getMatchingSchemas(document, jsonDocument),
  //   );
  // }

  private _getTextDocument(uri: string): jsonService.TextDocument | null {
    let models = this._ctx.getMirrorModels();
    for (let model of models) {
      if (model.uri.toString() === uri) {
        return jsonService.TextDocument.create(
          uri,
          "json",
          model.version,
          model.getValue(),
        );
      }
    }
    return null;
  }
}

initializeWorker(JSONWorker);
