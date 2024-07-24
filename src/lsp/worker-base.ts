import type monacoNS from "monaco-editor-core";
import { TextDocument } from "vscode-languageserver-textdocument";

export enum FileType {
  /**
   * A regular file.
   */
  File = 1,
  /**
   * A directory.
   */
  Directory = 2,
}

export interface WorkerVFS {
  files: string[];
}

export class WorkerBase<Host = undefined, LanguageDocument = undefined> {
  private _ctx: monacoNS.worker.IWorkerContext<Host>;
  private _vfs?: WorkerVFS;
  private _documentCache = new Map<string, [number, TextDocument, LanguageDocument | undefined]>();

  createLanguageDocument: (document: TextDocument) => LanguageDocument;

  constructor(ctx: monacoNS.worker.IWorkerContext<Host>, vfs?: WorkerVFS) {
    this._ctx = ctx;
    this._vfs = vfs;
  }

  get hasVFS(): boolean {
    return !!this._vfs;
  }

  get vfs(): WorkerVFS | undefined {
    return this._vfs;
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

  async removeDocumentCache(uri: string): Promise<void> {
    this._documentCache.delete(uri);
  }

  async updateVFS(evt: { kind: "create" | "remove"; path: string }): Promise<void> {
    const { kind, path } = evt;
    const url = new URL(path, "file:///").href;
    if (!this._vfs) {
      throw new Error("VFS not initialized");
    }
    const files = this._vfs.files;
    if (kind === "create") {
      files.push(url);
    } else {
      this.removeDocumentCache(url);
      const index = files.indexOf(url);
      if (index !== -1) {
        files.splice(index, 1);
      }
    }
  }

  // resolveReference implementes the `FileSystemProvider` interface
  resolveReference(ref: string, baseUrl: string): string | undefined {
    const url = new URL(ref, baseUrl);
    const href = url.href;
    if (url.protocol === "file:" && !url.pathname.endsWith("/")) {
      if (this.vfs) {
        const files = this.vfs.files;
        const isDir = href.endsWith("/");
        if (
          (isDir && !files.find((f) => f.startsWith(href)))
          || (!isDir && !files.includes(href))
        ) {
          return undefined;
        }
      }
    }
    return href;
  }

  getTextDocument(uri: string): TextDocument | null {
    const model = this.getModel(uri);
    if (!model) {
      return null;
    }
    const cached = this._documentCache.get(uri);
    if (cached && cached[0] === model.version) {
      return cached[1];
    }
    const document = TextDocument.create(uri, "-", model.version, model.getValue());
    this._documentCache.set(uri, [model.version, document, undefined]);
    return document;
  }

  getLanguageDocument(document: TextDocument): LanguageDocument {
    const { uri, version } = document;
    const cached = this._documentCache.get(uri);
    if (cached && cached[0] === version && cached[2]) {
      return cached[2];
    }
    const languageDocument = this.createLanguageDocument(document);
    this._documentCache.set(uri, [version, document, languageDocument]);
    return languageDocument;
  }

  readDir(uri: string, extensions?: readonly string[]): [string, FileType][] {
    const entries: [string, FileType][] = [];
    const dirs = new Set<string>();
    const files = this._vfs?.files;
    if (files) {
      for (const path of files) {
        if (path.startsWith(uri)) {
          const name = path.slice(uri.length);
          if (name.includes("/")) {
            const [dirName] = name.split("/");
            if (!dirs.has(dirName)) {
              dirs.add(dirName);
              entries.push([dirName, FileType.Directory]);
            }
          } else if (!extensions || extensions.some((ext) => name.endsWith(ext))) {
            entries.push([name, FileType.File]);
          }
        }
      }
    }
    return entries;
  }

  getFileSystemProvider() {
    if (!this._vfs) {
      throw new Error("VFS not initialized");
    }
    return {
      readDirectory: (uri: string) => {
        return Promise.resolve(this.readDir(uri));
      },
      stat: async (uri: string) => {
        // @ts-expect-error `vfs_stat` is defined in host
        return this._ctx.host.vfs_stat(uri);
      },
      getContent: async (uri: string, encoding?: string): Promise<string> => {
        // @ts-expect-error `vfs_readTextFile` is defined in host
        return this._ctx.host.vfs_readTextFile(uri);
      },
    };
  }
}

export { TextDocument };
