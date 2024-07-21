import type { editor, IPosition, IRange } from "./monaco.d.ts";

export interface VFile {
  url: string;
  version: number;
  content: string | Uint8Array;
  ctime: number;
  mtime: number;
}

export interface VFSEvent {
  kind: "create" | "modify" | "remove";
  path: string;
  isModelChange?: boolean;
}

interface VFSOptions {
  scope?: string;
  initial?: Record<string, string | Uint8Array>;
  defaultFile?: string;
  history?: "localStorage" | "browserHistory" | VFSHistory;
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
  exists(name: string | URL): Promise<boolean>;
  ls(): Promise<string[]>;
  open(name: string | URL): Promise<VFile>;
  readFile(name: string | URL): Promise<Uint8Array>;
  readTextFile(name: string | URL): Promise<string>;
  writeFile(name: string | URL, content: string | Uint8Array, version?: number): Promise<void>;
  remove(name: string | URL): Promise<void>;
  watch(name: "*" | string | URL, handler: (evt: VFSEvent) => void): () => void;
}

export class VFS extends BasicVFS {
  readonly defaultFile?: string;
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
