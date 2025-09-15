import type monacoNS from "monaco-editor-core";
import * as cssService from "vscode-css-languageservice";
import { WorkerBase } from "../worker-base.ts";

// ! external modules, don't remove the `.js` extension
import { initializeWorker } from "../../editor-worker.js";

export interface CSSDataConfiguration {
  /** Defines whether the standard CSS properties, at-directives, pseudoClasses and pseudoElements are shown. */
  useDefaultDataProvider?: boolean;
  /** Provides a set of custom data providers. */
  dataProviders?: { [providerId: string]: cssService.CSSDataV1 };
}

export interface CreateData {
  /** The language ID. */
  readonly language?: "css" | "less" | "scss";
  /** Configures the CSS data types known by the langauge service.  */
  readonly data?: CSSDataConfiguration;
  /** Settings for the CSS formatter. */
  readonly format?: cssService.CSSFormatConfiguration;
  /** Whether the worker has a file system provider. */
  readonly workspace?: boolean;
}

export class CSSWorker extends WorkerBase<{}, cssService.Stylesheet> {
  private _formatSettings: cssService.CSSFormatConfiguration;
  private _languageService: cssService.LanguageService;

  constructor(ctx: monacoNS.worker.IWorkerContext, createData: CreateData) {
    super(ctx, createData, (document) => this._languageService.parseStylesheet(document));
    const data = createData.data;
    const customDataProviders: cssService.ICSSDataProvider[] = [];
    if (data?.dataProviders) {
      for (const id in data.dataProviders) {
        customDataProviders.push(cssService.newCSSDataProvider(data.dataProviders[id]));
      }
    }
    const langauge = createData.language ?? "css";
    const languageServiceOptions: cssService.LanguageServiceOptions = {
      customDataProviders,
      useDefaultDataProvider: data?.useDefaultDataProvider,
      fileSystemProvider: this.getFileSystemProvider(),
    };
    this._formatSettings = createData.format ?? {};
    this._languageService = langauge === "less"
      ? cssService.getLESSLanguageService(languageServiceOptions)
      : langauge === "scss"
      ? cssService.getSCSSLanguageService(languageServiceOptions)
      : cssService.getCSSLanguageService(languageServiceOptions);
  }

  async doValidation(uri: string): Promise<cssService.Diagnostic[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    return this._languageService.doValidation(document, stylesheet);
  }

  async doComplete(uri: string, position: cssService.Position): Promise<cssService.CompletionList | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    return this._languageService.doComplete2(document, position, stylesheet, this);
  }

  async doHover(uri: string, position: cssService.Position): Promise<cssService.Hover | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    return this._languageService.doHover(document, position, stylesheet);
  }

  async doCodeAction(
    uri: string,
    range: cssService.Range,
    context: cssService.CodeActionContext,
  ): Promise<cssService.CodeAction[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    return this._languageService.doCodeActions2(document, range, context, stylesheet);
  }

  async doRename(uri: string, position: cssService.Position, newName: string): Promise<cssService.WorkspaceEdit | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    return this._languageService.doRename(document, position, newName, stylesheet);
  }

  async doFormat(
    uri: string,
    range: cssService.Range | null,
    options: cssService.CSSFormatConfiguration,
  ): Promise<cssService.TextEdit[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const settings = { ...this._formatSettings, ...options };
    return this._languageService.format(document, range!, settings);
  }

  async findDocumentSymbols(uri: string): Promise<cssService.DocumentSymbol[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    return this._languageService.findDocumentSymbols2(document, stylesheet);
  }

  async findDefinition(uri: string, position: cssService.Position): Promise<cssService.Location[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    const definition = this._languageService.findDefinition(document, position, stylesheet);
    if (definition) {
      return [definition];
    }
    return null;
  }

  async findReferences(uri: string, position: cssService.Position): Promise<cssService.Location[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    return this._languageService.findReferences(document, position, stylesheet);
  }

  async findDocumentLinks(uri: string): Promise<cssService.DocumentLink[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    return this._languageService.findDocumentLinks2(document, stylesheet, this);
  }

  async findDocumentHighlights(
    uri: string,
    position: cssService.Position,
  ): Promise<cssService.DocumentHighlight[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    return this._languageService.findDocumentHighlights(document, position, stylesheet);
  }

  async findDocumentColors(uri: string): Promise<cssService.ColorInformation[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    return this._languageService.findDocumentColors(document, stylesheet);
  }

  async getColorPresentations(
    uri: string,
    color: cssService.Color,
    range: cssService.Range,
  ): Promise<cssService.ColorPresentation[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    return this._languageService.getColorPresentations(document, stylesheet, color, range);
  }

  async getFoldingRanges(uri: string, context?: { rangeLimit?: number }): Promise<cssService.FoldingRange[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    return this._languageService.getFoldingRanges(document, context);
  }

  async getSelectionRanges(uri: string, positions: cssService.Position[]): Promise<cssService.SelectionRange[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const stylesheet = this.getLanguageDocument(document);
    return this._languageService.getSelectionRanges(document, positions, stylesheet);
  }
}

initializeWorker(CSSWorker);
