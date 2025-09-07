import type monacoNS from "monaco-editor-core";
import * as htmlService from "vscode-html-languageservice";
import { getDocumentRegions } from "./embedded-support.ts";
import { WorkerBase } from "../worker-base.ts";

// ! external modules, don't remove the `.js` extension
import { initializeWorker } from "../../editor-worker.js";

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

export interface CreateData {
  /** Settings for the HTML formatter. */
  readonly format?: htmlService.HTMLFormatConfiguration;
  /** Code completion settings. */
  readonly suggest?: htmlService.CompletionConfiguration;
  /** HTML data configuration. */
  readonly data?: HTMLDataConfiguration;
  /** Whether the worker has a file system provider. */
  readonly workspace?: boolean;
}

export class HTMLWorker extends WorkerBase<undefined, htmlService.HTMLDocument> {
  private _formatSettings: htmlService.HTMLFormatConfiguration;
  private _suggestSettings: htmlService.CompletionConfiguration;
  private _languageService: htmlService.LanguageService;

  constructor(ctx: monacoNS.worker.IWorkerContext, createData: CreateData) {
    super(ctx, createData, (document) => this._languageService.parseHTMLDocument(document));
    const data = createData.data;
    const useDefaultDataProvider = data?.useDefaultDataProvider;
    const fileSystemProvider = this.getFileSystemProvider();
    const customDataProviders: htmlService.IHTMLDataProvider[] = [];
    if (data?.dataProviders) {
      for (const id in data.dataProviders) {
        customDataProviders.push(
          htmlService.newHTMLDataProvider(id, data.dataProviders[id]),
        );
      }
    }
    this._formatSettings = createData.format ?? {};
    this._suggestSettings = createData.suggest ?? {};
    this._languageService = htmlService.getLanguageService({ customDataProviders, useDefaultDataProvider, fileSystemProvider });
  }

  async doValidation(uri: string): Promise<htmlService.Diagnostic[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const diagnostic: htmlService.Diagnostic[] = [];
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

  async doAutoComplete(uri: string, position: htmlService.Position, ch: string): Promise<string | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const htmlDocument = this.getLanguageDocument(document);
    if (ch === ">" || ch === "/") {
      return this._languageService.doTagComplete(document, position, htmlDocument);
    } else if (ch === "=") {
      const insertText = this._languageService.doQuoteComplete(document, position, htmlDocument, this._suggestSettings);
      if (!insertText) {
        return null;
      }
      return insertText.replaceAll("$1", "$0");
    }
    return null;
  }

  async doComplete(uri: string, position: htmlService.Position): Promise<htmlService.CompletionList | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    const rsl = rs.getEmbeddedLanguageAtPosition(position);
    if (rsl) {
      return { $embedded: rsl } as any;
    }
    const htmlDocument = this.getLanguageDocument(document);
    return this._languageService.doComplete2(
      document,
      position,
      htmlDocument,
      this,
      this._suggestSettings,
    );
  }

  async doHover(uri: string, position: htmlService.Position): Promise<htmlService.Hover | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    const rsl = rs.getEmbeddedLanguageAtPosition(position);
    if (rsl) {
      return { $embedded: rsl } as any;
    }
    const htmlDocument = this.getLanguageDocument(document);
    return this._languageService.doHover(document, position, htmlDocument);
  }

  async doFormat(
    uri: string,
    formatRange: htmlService.Range,
    options: htmlService.FormattingOptions,
  ): Promise<htmlService.TextEdit[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }

    const contentUnformatted = this._formatSettings.contentUnformatted ?? "";
    const formattingOptions = {
      ...this._formatSettings,
      ...options,
      // remove last newline to allow embedded css to be formatted with newline
      endWithNewline: false,
      // unformat `<script>` tag
      contentUnformatted: contentUnformatted + ", script",
    };
    const edits = this._languageService.format(document, formatRange, formattingOptions);

    // add last newline if needed
    if (this._formatSettings.endWithNewline) {
      const text = document.getText();
      edits.push({
        range: {
          start: document.positionAt(text.length),
          end: document.positionAt(text.length),
        },
        newText: "\n",
      });
    }

    // todo: format embedded import-map

    return edits;
  }

  async doRename(uri: string, position: htmlService.Position, newName: string): Promise<htmlService.WorkspaceEdit | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    const rsl = rs.getEmbeddedLanguageAtPosition(position);
    if (rsl) {
      return { $embedded: rsl } as any;
    }
    const htmlDocument = this.getLanguageDocument(document);
    return this._languageService.doRename(document, position, newName, htmlDocument);
  }

  async findDefinition(
    uri: string,
    position: htmlService.Position,
  ): Promise<(htmlService.Location & { originSelectionRange?: htmlService.Range })[] | null> {
    const document = this.getTextDocument(uri);
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

  async findReferences(uri: string, position: htmlService.Position): Promise<htmlService.Location[] | null> {
    const document = this.getTextDocument(uri);
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

  async findDocumentLinks(uri: string): Promise<htmlService.DocumentLink[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    return this._languageService.findDocumentLinks(document, this);
  }

  async findDocumentSymbols(uri: string): Promise<htmlService.DocumentSymbol[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const htmlDocument = this.getLanguageDocument(document);
    return this._languageService.findDocumentSymbols2(
      document,
      htmlDocument,
    );
  }

  async findDocumentHighlights(uri: string, position: htmlService.Position): Promise<htmlService.DocumentHighlight[]> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return [];
    }
    const rs = getDocumentRegions(this._languageService, document);
    const rsl = rs.getEmbeddedLanguageAtPosition(position);
    if (rsl) {
      return { $embedded: rsl } as any;
    }
    const htmlDocument = this.getLanguageDocument(document);
    return this._languageService.findDocumentHighlights(
      document,
      position,
      htmlDocument,
    );
  }

  async getFoldingRanges(uri: string, context?: { rangeLimit?: number }): Promise<htmlService.FoldingRange[] | null> {
    const document = this.getTextDocument(uri);
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

  async getSelectionRanges(uri: string, positions: htmlService.Position[]): Promise<htmlService.SelectionRange[]> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return [];
    }
    return this._languageService.getSelectionRanges(document, positions);
  }

  async findDocumentColors(uri: string): Promise<htmlService.ColorInformation[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    if (rs.hasEmbeddedLanguage("css")) {
      return { $embedded: "css" } as any;
    }
    return null;
  }

  async getColorPresentations(
    uri: string,
    color: htmlService.Color,
    range: htmlService.Range,
  ): Promise<htmlService.ColorPresentation[] | null> {
    const document = this.getTextDocument(uri);
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
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const rs = getDocumentRegions(this._languageService, document);
    const content = rs.getEmbeddedDocument(languageId, false);
    if (content) {
      return { content };
    }
    return null;
  }
}

initializeWorker(HTMLWorker);
