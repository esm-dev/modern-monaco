import type { editor } from "./monaco.d.ts";
import type { showInputBox, showQuickPick } from "./vscode.d.ts";

export interface WorkspaceInit {
  /** name of the workspace. */
  name?: string;
  /** initial files in the workspace */
  initialFiles?: Record<string, string | Uint8Array>;
  /** file to open when the editor is loaded at first time */
  entryFile?: string;
  /** whether to use browser history for navigation. */
  browserHistory?: boolean | { basePath: string };
  /** custom filesystem implementation to override the default IndexedDB filesystem */
  customFS?: FileSystem;
}

export class Workspace {
  constructor(options?: WorkspaceInit);
  readonly entryFile?: string;
  readonly fs: FileSystem;
  readonly history: WorkspaceHistory;
  readonly viewState: WorkspaceViewState;
  openTextDocument(uri: string | URL, content?: string): Promise<editor.ITextModel>;
  showInputBox: typeof showInputBox;
  showQuickPick: typeof showQuickPick;
}

export interface WorkspaceViewState {
  get(uri: string | URL): Promise<editor.ICodeEditorViewState | undefined>;
  save(uri: string | URL, viewState: editor.ICodeEditorViewState): Promise<void>;
}

export interface WorkspaceHistoryState {
  readonly current: string;
}

export interface WorkspaceHistory {
  readonly state: WorkspaceHistoryState;
  back(): void;
  forward(): void;
  push(path: string): void;
  replace(path: string): void;
  onChange(callback: (state: WorkspaceHistoryState) => void): () => void;
}

/**
 * The type of a file system entry.
 * - `0`: unknown
 * - `1`: file
 * - `2`: directory
 * - `64`: symlink
 */
export type FileSystemEntryType = 0 | 1 | 2 | 64;

export interface FileSystemWatchContext {
  isModelContentChange?: boolean;
}

export interface FileSystemWatchHandle {
  (kind: "create" | "modify" | "remove", filename: string, type?: number, context?: FileSystemWatchContext): void;
}

export interface FileStat {
  readonly type: FileSystemEntryType;
  readonly ctime: number;
  readonly mtime: number;
  readonly version: number;
  readonly size: number;
}

export interface FileSystem {
  copy(source: string, target: string, options?: { overwrite: boolean }): Promise<void>;
  createDirectory(dir: string): Promise<void>;
  delete(filename: string, options?: { recursive: boolean }): Promise<void>;
  readDirectory(filename: string): Promise<[string, number][]>;
  readFile(filename: string): Promise<Uint8Array>;
  readTextFile(filename: string): Promise<string>;
  rename(oldName: string, newName: string, options?: { overwrite: boolean }): Promise<void>;
  stat(filename: string): Promise<FileStat>;
  writeFile(filename: string, content: string | Uint8Array, context?: FileSystemWatchContext): Promise<void>;
  watch(filename: string, options: { recursive: boolean }, handle: FileSystemWatchHandle): () => void;
  watch(filename: string, handle: FileSystemWatchHandle): () => void;
}

export class ErrorNotFound extends Error {}
