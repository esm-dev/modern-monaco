import type { editor, IPosition, IRange } from "./monaco.d.ts";

declare global {
  interface VFSState {
    activeFile?: string;
  }
}

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

export class VFS {
  constructor(options?: VFSOptions);
  readonly ErrorNotFound: typeof ErrorNotFound;
  exists(name: string | URL): Promise<boolean>;
  ls(): Promise<string[]>;
  open(name: string | URL): Promise<VFile>;
  openModel(
    name: string | URL,
    attachTo?: editor.ICodeEditor | number | string | boolean,
    selectionOrPosition?: IRange | IPosition,
  ): Promise<editor.ITextModel>;
  readFile(name: string | URL): Promise<Uint8Array>;
  readTextFile(name: string | URL): Promise<string>;
  writeFile(name: string | URL, content: string | Uint8Array, version?: number): Promise<void>;
  remove(name: string | URL): Promise<void>;
  watch(name: string | URL, handler: (evt: VFSEvent) => void): () => void;
  useList(effect: (list: string[]) => void): () => void;
  useState(effect: (state: VFSState) => void): () => void;
}

export class ErrorNotFound extends Error {}
