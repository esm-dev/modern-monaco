import type monacoNS from "monaco-editor-core";
import { TextDocument } from "vscode-languageserver-textdocument";

export enum FileType {
  /**  A regular file. */
  File = 1,
  /** A directory. */
  Directory = 2,
}

export class WorkerBase<Host = {}, LanguageDocument = undefined> {
  #documentCache = new Map<string, [number, TextDocument, LanguageDocument | undefined]>();
  #fs?: Map<string, number>;

  constructor(
    private _ctx: monacoNS.worker.IWorkerContext<Host>,
    private _createData: { workspace?: boolean },
    private _createLanguageDocument?: (document: TextDocument) => LanguageDocument,
  ) {}

  get hasFileSystemProvider(): boolean {
    return !!this._createData.workspace;
  }

  get host() {
    return this._ctx.host;
  }

  getMirrorModels() {
    return this._ctx.getMirrorModels();
  }

  hasModel(fileName: string): boolean {
    const models = this.getMirrorModels();
    for (let i = 0; i < models.length; i++) {
      const uri = models[i].uri;
      if (uri.toString() === fileName || uri.toString(true) === fileName) {
        return true;
      }
    }
    return false;
  }

  getModel(fileName: string): monacoNS.worker.IMirrorModel | null {
    const models = this.getMirrorModels();
    for (let i = 0; i < models.length; i++) {
      const uri = models[i].uri;
      if (uri.toString() === fileName || uri.toString(true) === fileName) {
        return models[i];
      }
    }
    return null;
  }

  getTextDocument(uri: string): TextDocument | null {
    const model = this.getModel(uri);
    if (!model) {
      return null;
    }
    const cached = this.#documentCache.get(uri);
    if (cached && cached[0] === model.version) {
      return cached[1];
    }
    const document = TextDocument.create(uri, "-", model.version, model.getValue());
    this.#documentCache.set(uri, [model.version, document, undefined]);
    return document;
  }

  getLanguageDocument(document: TextDocument): LanguageDocument {
    const { uri, version } = document;
    const cached = this.#documentCache.get(uri);
    if (cached && cached[0] === version && cached[2]) {
      return cached[2];
    }
    if (!this._createLanguageDocument) {
      throw new Error("createLanguageDocument is not provided");
    }
    const languageDocument = this._createLanguageDocument(document);
    this.#documentCache.set(uri, [version, document, languageDocument]);
    return languageDocument;
  }

  readDir(uri: string, extensions?: readonly string[]): [string, FileType][] {
    const entries: [string, FileType][] = [];
    if (this.#fs) {
      for (const [path, type] of this.#fs) {
        if (path.startsWith(uri)) {
          const name = path.slice(uri.length);
          if (!name.includes("/")) {
            if (type === 2) {
              entries.push([name, FileType.Directory]);
            } else if (!extensions || extensions.some((ext) => name.endsWith(ext))) {
              entries.push([name, FileType.File]);
            }
          }
        }
      }
    }
    return entries;
  }

  getFileSystemProvider() {
    if (this.hasFileSystemProvider) {
      const host = this._ctx.host;
      return {
        readDirectory: (uri: string): Promise<[string, FileType][]> => {
          return Promise.resolve(this.readDir(uri));
        },
        stat: (uri: string): Promise<{ type: FileType; ctime: number; mtime: number; size: number }> => {
          // @ts-expect-error `fs_stat` is defined in host
          return host.fs_stat(uri);
        },
        getContent: (uri: string, encoding?: string): Promise<string> => {
          // @ts-expect-error `fs_getContent` is defined in host
          return host.fs_getContent(uri);
        },
      };
    }
    return undefined;
  }

  // resolveReference implementes the `DocumentContext` interface
  resolveReference(ref: string, baseUrl: string): string | undefined {
    const url = new URL(ref, baseUrl);
    const href = url.href;
    // if the file is not in the file system, return undefined
    if (url.protocol === "file:" && url.pathname !== "/" && this.#fs && !this.#fs.has(href.endsWith("/") ? href.slice(0, -1) : href)) {
      return undefined;
    }
    return href;
  }

  // #region methods used by the host

  async removeDocumentCache(uri: string): Promise<void> {
    this.#documentCache.delete(uri);
  }

  async fsNotify(kind: "create" | "remove", path: string, type?: number): Promise<void> {
    const url = "file://" + path;
    const entries = this.#fs ?? (this.#fs = new Map());
    if (kind === "create") {
      if (type) {
        entries.set(url, type);
      }
    } else if (kind === "remove") {
      if (entries.get(url) === FileType.File) {
        this.#documentCache.delete(url);
      }
      entries.delete(url);
    }
  }

  // #endregion
}

export { TextDocument };
