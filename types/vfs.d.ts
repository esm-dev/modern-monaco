import type { editor, IPosition, IRange } from "./monaco.d.ts";

interface VFSOptions {
  /** scope of the VFS, used for project isolation, default is "default" */
  scope?: string;
  /** initial files in the VFS */
  initial?: Record<string, string | Uint8Array>;
  /** file to open when the editor is loaded at first time */
  entryFile?: string;
  /** history provider, default is "localStorage" */
  history?: "localStorage" | "browserHistory" | VFSHistory;
}

interface VFSEvent {
  /** The kind of the event. */
  kind: "create" | "modify" | "remove";
  /** The path of the file. */
  path: string;
  /** If the event is triggered by model content change. */
  isModelContentChange?: boolean;
}

interface VFile {
  url: string;
  version: number;
  content: string | Uint8Array;
  ctime: number;
  mtime: number;
}

interface VFSHistory {
  readonly current: string;
  back(): void;
  forward(): void;
  push(name: string | URL): void;
  replace(name: string | URL): void;
  onChange(handler: (name: string) => void): () => void;
}

export class BasicVFS {
  readonly ErrorNotFound: typeof ErrorNotFound;
  constructor(options?: VFSOptions);
  ls(): Promise<string[]>;
  exists(name: string | URL): Promise<boolean>;
  open(name: string | URL): Promise<VFile>;
  readFile(name: string | URL): Promise<Uint8Array>;
  readTextFile(name: string | URL): Promise<string>;
  writeFile(name: string | URL, content: string | Uint8Array, version?: number): Promise<void>;
  remove(name: string | URL): Promise<void>;
  watch(name: "*" | (string & {}) | URL, handler: (evt: VFSEvent) => void): () => void;
}

export class VFS extends BasicVFS {
  readonly entryFile?: string;
  readonly history: VFSHistory;
  openModel(name: string | URL, attachTo?: editor.ICodeEditor, selectionOrPosition?: IRange | IPosition): Promise<editor.ITextModel>;
}

export class VFSBrowserHistory implements VFSHistory {
  constructor(basePath?: string);
  readonly current: string;
  back(): void;
  forward(): void;
  push(name: string | URL): void;
  replace(name: string | URL): void;
  onChange(handler: (name: string) => void): () => void;
}

export class VFSLocalStorageHistory implements VFSHistory {
  constructor(scope: string, maxHistory?: number);
  readonly current: string;
  back(): void;
  forward(): void;
  push(name: string | URL): void;
  replace(name: string | URL): void;
  onChange(handler: (name: string) => void): () => void;
}

export class ErrorNotFound extends Error {}
