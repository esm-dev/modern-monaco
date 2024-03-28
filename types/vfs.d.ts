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

export interface VFSOptions {
  scope?: string;
  initial?: Record<string, string[] | string | Uint8Array>;
}

export interface VFSState {
  activeFile?: string;
}

export class VFS {
  constructor(options?: VFSOptions);
  readonly ErrorNotFound: typeof ErrorNotFound;
  openModel(
    name: string | URL,
    attachTo?: editor.ICodeEditor | number | string | boolean,
    selectionOrPosition?: IRange | IPosition,
  ): Promise<editor.ITextModel>;
  exists(name: string | URL): Promise<boolean>;
  list(): Promise<string[]>;
  read(name: string | URL): Promise<VFile>;
  readFile(name: string | URL): Promise<Uint8Array>;
  readTextFile(name: string | URL): Promise<string>;
  writeFile(name: string | URL, content: string | Uint8Array, version?: number): Promise<void>;
  removeFile(name: string | URL): Promise<void>;
  watch(name: string | URL, handler: (evt: VFSEvent) => void): () => void;
  useList(callback: (list: string[]) => void): () => void;
  useState(callback: (state: VFSState) => void): () => void;
}

export class ErrorNotFound extends Error {}
