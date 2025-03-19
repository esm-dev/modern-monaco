import type monacoNS from "monaco-editor-core";
import * as jsonService from "vscode-json-languageservice";
import { WorkerBase } from "../worker-base.ts";

// ! external modules, don't remove the `.js` extension
import { cache } from "../../cache.js";
import { initializeWorker } from "../../editor-worker.js";

/** The create data for a new json worker. */
export interface CreateData {
  /** Configures the CSS data types known by the langauge service. */
  readonly settings?: jsonService.LanguageSettings & jsonService.DocumentLanguageSettings;
  /** Settings for the CSS formatter. */
  readonly format?: jsonService.FormattingOptions;
}

export class JSONWorker extends WorkerBase<undefined, jsonService.JSONDocument> {
  private _formatSettings?: jsonService.FormattingOptions;
  private _languageService: jsonService.LanguageService;

  constructor(ctx: monacoNS.worker.IWorkerContext, createData: CreateData) {
    super(ctx, (document) => this._languageService.parseJSONDocument(document));
    this._formatSettings = createData.format;
    this._languageService = jsonService.getLanguageService({
      workspaceContext: {
        resolveRelativePath: (relativePath: string, resource: string) => {
          return new URL(relativePath, resource).href;
        },
      },
      schemaRequestService: (uri) => {
        const url = new URL(uri);
        if (url.protocol === "https:" || url.protocol === "http:") {
          return cache.fetch(url).then((res) => res.text());
        } else if (url.protocol === "file:") {
          const fs = this.getFileSystemProvider();
          if (fs) {
            return fs.getContent(uri);
          }
        }
        return Promise.reject(new Error("Schema not found"));
      },
      promiseConstructor: Promise,
      clientCapabilities: jsonService.ClientCapabilities.LATEST,
    });
    if (createData.settings) {
      this._languageService.configure(createData.settings);
    }
  }

  async doValidation(uri: string): Promise<jsonService.Diagnostic[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const jsonDocument = this.getLanguageDocument(document);
    return this._languageService.doValidation(document, jsonDocument);
  }

  async doComplete(uri: string, position: jsonService.Position): Promise<jsonService.CompletionList | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const jsonDocument = this.getLanguageDocument(document);
    return this._languageService.doComplete(document, position, jsonDocument);
  }

  async doResolveCompletionItem(item: jsonService.CompletionItem): Promise<jsonService.CompletionItem | null> {
    return this._languageService.doResolve(item);
  }

  async doHover(uri: string, position: jsonService.Position): Promise<jsonService.Hover | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const jsonDocument = this.getLanguageDocument(document);
    return this._languageService.doHover(document, position, jsonDocument);
  }

  async doRename(uri: string, position: jsonService.Position, newName: string): Promise<jsonService.WorkspaceEdit | null> {
    return null;
  }

  async doFormat(
    uri: string,
    range: jsonService.Range | null,
    options: jsonService.FormattingOptions,
    docText?: string,
  ): Promise<jsonService.TextEdit[] | null> {
    const document = docText ? jsonService.TextDocument.create(uri, "json", 0, docText) : this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const settings = { ...this._formatSettings, ...options };
    return this._languageService.format(document, range!, settings);
  }

  async findDocumentSymbols(uri: string): Promise<jsonService.DocumentSymbol[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const jsonDocument = this.getLanguageDocument(document);
    return this._languageService.findDocumentSymbols2(document, jsonDocument);
  }

  async findDefinition(uri: string, position: jsonService.Position): Promise<jsonService.DefinitionLink[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const jsonDocument = this.getLanguageDocument(document);
    const definition = await this._languageService.findDefinition(document, position, jsonDocument);
    if (definition) {
      return definition;
    }
    return null;
  }

  async findReferences(uri: string, position: jsonService.Position): Promise<jsonService.Location[] | null> {
    return null;
  }

  async findDocumentLinks(uri: string): Promise<jsonService.DocumentLink[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const jsonDocument = this.getLanguageDocument(document);
    return this._languageService.findLinks(document, jsonDocument);
  }

  async findDocumentHighlights(uri: string, position: jsonService.Position): Promise<jsonService.DocumentHighlight[] | null> {
    return null;
  }

  async findDocumentColors(uri: string): Promise<jsonService.ColorInformation[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const jsonDocument = this.getLanguageDocument(document);
    return this._languageService.findDocumentColors(document, jsonDocument);
  }

  async getColorPresentations(
    uri: string,
    color: jsonService.Color,
    range: jsonService.Range,
  ): Promise<jsonService.ColorPresentation[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const jsonDocument = this.getLanguageDocument(document);
    return this._languageService.getColorPresentations(
      document,
      jsonDocument,
      color,
      range,
    );
  }

  async getFoldingRanges(uri: string, context?: { rangeLimit?: number }): Promise<jsonService.FoldingRange[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    return this._languageService.getFoldingRanges(document, context);
  }

  async getSelectionRanges(uri: string, positions: jsonService.Position[]): Promise<jsonService.SelectionRange[] | null> {
    const document = this.getTextDocument(uri);
    if (!document) {
      return null;
    }
    const jsonDocument = this.getLanguageDocument(document);
    return this._languageService.getSelectionRanges(document, positions, jsonDocument);
  }

  async resetSchema(uri: string): Promise<boolean> {
    return this._languageService.resetSchema(uri);
  }
}

initializeWorker(JSONWorker);
