import type monacoNS from "monaco-editor-core";
import type { FileSystemEntryType } from "../../types/workspace.d.ts";
import { TextDocument } from "vscode-languageserver-textdocument";

export interface WorkerCreateData {
  fs?: string[];
}

export class WorkerBase<Host = undefined, LanguageDocument = undefined> {
  #ctx: monacoNS.worker.IWorkerContext<Host>;
  #fs?: Map<string, FileSystemEntryType>;
  #documentCache = new Map<string, [number, TextDocument, LanguageDocument | undefined]>();
  #createLanguageDocument?: (document: TextDocument) => LanguageDocument;

  constructor(
    ctx: monacoNS.worker.IWorkerContext<Host>,
    createData: WorkerCreateData,
    createLanguageDocument?: (document: TextDocument) => LanguageDocument,
  ) {
    this.#ctx = ctx;
    if (createData.fs) {
      const dirs = new Set<string>(["/"]);
      this.#fs = new Map(createData.fs.map((path) => {
        const dir = path.slice(0, path.lastIndexOf("/"));
        if (dir) {
          dirs.add(dir);
        }
        return ["file://" + path, 1];
      }));
      for (const dir of dirs) {
        this.#fs.set("file://" + dir, 2);
      }
      createData.fs.length = 0;
    }
    this.#createLanguageDocument = createLanguageDocument;
  }

  get hasFileSystemProvider(): boolean {
    return !!this.#fs;
  }

  get host() {
    return this.#ctx.host;
  }

  getMirrorModels() {
    return this.#ctx.getMirrorModels();
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
    if (!this.#createLanguageDocument) {
      throw new Error("createLanguageDocument is not provided");
    }
    const languageDocument = this.#createLanguageDocument(document);
    this.#documentCache.set(uri, [version, document, languageDocument]);
    return languageDocument;
  }

  readDir(uri: string, extensions?: readonly string[]): [string, FileSystemEntryType][] {
    const entries: [string, FileSystemEntryType][] = [];
    if (this.#fs) {
      for (const [path, type] of this.#fs) {
        if (path.startsWith(uri)) {
          const name = path.slice(uri.length);
          if (!name.includes("/")) {
            if (type === 1) {
              if (!extensions || extensions.some((ext) => name.endsWith(ext))) {
                entries.push([name, 1]);
              }
            } else if (type === 2) {
              entries.push([name, 2]);
            }
          }
        }
      }
    }
    return entries;
  }

  getFileSystemProvider() {
    if (this.#fs) {
      const host = this.#ctx.host;
      return {
        readDirectory: (uri: string): Promise<[string, FileSystemEntryType][]> => {
          return Promise.resolve(this.readDir(uri));
        },
        stat: (uri: string): Promise<{ type: FileSystemEntryType; ctime: number; mtime: number; size: number }> => {
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
    const { protocol, pathname, href } = new URL(ref, baseUrl);
    // if the file is not in the file system, return undefined
    if (protocol === "file:" && pathname !== "/" && this.#fs && !this.#fs.has(href.endsWith("/") ? href.slice(0, -1) : href)) {
      return undefined;
    }
    return href;
  }

  // #region methods used by the host

  async releaseDocument(uri: string): Promise<void> {
    this.#documentCache.delete(uri);
  }

  async fsNotify(kind: "create" | "remove", path: string, type?: number): Promise<void> {
    const fs = this.#fs ?? (this.#fs = new Map());
    if (kind === "create") {
      if (type) {
        fs.set(path, type);
      }
    } else if (kind === "remove") {
      if (fs.get(path) === 1) {
        this.#documentCache.delete(path);
      }
      fs.delete(path);
    }
  }

  // #endregion
}

export { TextDocument };
