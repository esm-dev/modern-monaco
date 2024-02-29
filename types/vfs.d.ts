import type { editor, IPosition, IRange } from "./monaco";
import type { ImportMap } from "./importmap";

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
  [key: string]: any;
  activeFile?: string;
}

export class VFS {
  constructor(options?: VFSOptions);
  readonly ErrorNotFound: typeof ErrorNotFound;
  readonly state: VFSState;
  openModel(
    name: string | URL,
    attachTo?: editor.ICodeEditor | number | string | boolean,
    selectionOrPosition?: IRange | IPosition,
  ): Promise<editor.ITextModel>;
  exists(name: string | URL): Promise<boolean>;
  list(): Promise<string[]>;
  readFile(name: string | URL): Promise<Uint8Array>;
  readTextFile(name: string | URL): Promise<string>;
  loadImportMap(map?: (im: ImportMap) => ImportMap): Promise<ImportMap>;
  writeFile(name: string | URL, content: string | Uint8Array, version?: number): Promise<void>;
  removeFile(name: string | URL): Promise<void>;
  watch(name: string | URL, handler: (evt: VFSEvent) => void): () => void;
  watchState(handler: () => void): () => void;
  useList(handler: (list: string[]) => void): () => void;
  useState<T>(get: (state: VFSState) => T, handler: (value: T) => void): () => void;
}

export class ErrorNotFound extends Error {}

export function parseImportMapFromJson(json: string, baseURL?: string): ImportMap;
export function blankImportMap(): ImportMap;
