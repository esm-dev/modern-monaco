/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) X. <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type monacoNS from "monaco-editor-core";
import * as jsonService from "vscode-json-languageservice";
import { cache } from "../../cache.js";

/** Options for json language service. */
export interface Options {
  /** Configures the CSS data types known by the langauge service. */
  readonly settings?: jsonService.LanguageSettings & jsonService.DocumentLanguageSettings;
  /** Settings for the CSS formatter. */
  readonly format?: jsonService.FormattingOptions;
}

/** The create data for a new json worker. */
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
    const document = this._getTextDocument(uri);
    if (document) {
      const jsonDocument = this._languageService.parseJSONDocument(document);
      return this._languageService.doValidation(document, jsonDocument);
    }
    return [];
  }

  async doComplete(uri: string, position: jsonService.Position): Promise<jsonService.CompletionList | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const jsonDocument = this._languageService.parseJSONDocument(document);
    return this._languageService.doComplete(document, position, jsonDocument);
  }

  async doResolveCompletionItem(item: jsonService.CompletionItem): Promise<jsonService.CompletionItem | null> {
    return this._languageService.doResolve(item);
  }

  async doHover(uri: string, position: jsonService.Position): Promise<jsonService.Hover | null> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return null;
    }
    const jsonDocument = this._languageService.parseJSONDocument(document);
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

  async findDocumentSymbols(uri: string): Promise<jsonService.DocumentSymbol[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    const jsonDocument = this._languageService.parseJSONDocument(document);
    return this._languageService.findDocumentSymbols2(
      document,
      jsonDocument,
    );
  }

  async findDocumentColors(uri: string): Promise<jsonService.ColorInformation[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    const jsonDocument = this._languageService.parseJSONDocument(document);
    return this._languageService.findDocumentColors(document, jsonDocument);
  }

  async getColorPresentations(
    uri: string,
    color: jsonService.Color,
    range: jsonService.Range,
  ): Promise<jsonService.ColorPresentation[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    const jsonDocument = this._languageService.parseJSONDocument(document);
    return this._languageService.getColorPresentations(
      document,
      jsonDocument,
      color,
      range,
    );
  }

  async getFoldingRanges(uri: string, context?: { rangeLimit?: number }): Promise<jsonService.FoldingRange[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    return this._languageService.getFoldingRanges(document, context);
  }

  async getSelectionRanges(uri: string, positions: jsonService.Position[]): Promise<jsonService.SelectionRange[]> {
    const document = this._getTextDocument(uri);
    if (!document) {
      return [];
    }
    const jsonDocument = this._languageService.parseJSONDocument(document);
    return this._languageService.getSelectionRanges(document, positions, jsonDocument);
  }

  async resetSchema(uri: string): Promise<boolean> {
    return this._languageService.resetSchema(uri);
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
    const models = this._ctx.getMirrorModels();
    for (const model of models) {
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

// ! external module, don't remove the `.js` extension
import { initializeWorker } from "../../editor-worker.js";
initializeWorker(JSONWorker);
