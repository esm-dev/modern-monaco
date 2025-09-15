import type monacoNS from "monaco-editor-core";
import type { Workspace } from "./workspace.js";
import type {
  FileSystemEntryType,
  FileSystemWatchHandle,
  WorkspaceInit,
  WorkspaceInitMultiple,
} from "../types/workspace";

/** Workspace URI utilities */
export const WorkspaceURI = {
  addWorkspacePrefix(uri: string, workspaceName: string): string {
    if (!workspaceName || workspaceName === "default") return uri;
    return `/workspace/${workspaceName}${uri}`;
  },

  removeWorkspacePrefix(uri: string, workspaceName?: string): string {
    if (!workspaceName || workspaceName === "default") return uri;

    const workspacePrefix = `/workspace/${workspaceName}`;
    return uri.includes(workspacePrefix)
      ? uri.replace(workspacePrefix, "")
      : uri;
  },

  hasWorkspacePrefix(uri: string): boolean {
    return /^(?:file:\/\/)?\/workspace\/[^\/]+/.test(uri);
  },

  extractWorkspaceName(uri: string): string | null {
    const match = uri.match(/^(?:file:\/\/)?\/workspace\/([^\/]+)/);
    return match ? match[1] : null;
  },

  transformForWorkspace(uri: string, workspaceName: string): string {
    if (!workspaceName || workspaceName === "default") return uri;

    // If already has workspace prefix, return as-is
    if (this.hasWorkspacePrefix(uri)) return uri;

    // Add workspace prefix
    const isFileProtocol = uri.startsWith("file://");
    const path = isFileProtocol ? uri.replace("file://", "") : uri;
    const prefixedPath = this.addWorkspacePrefix(path, workspaceName);

    return isFileProtocol ? `file://${prefixedPath}` : prefixedPath;
  },

  getOriginalURI(uri: string): string {
    const workspaceName = this.extractWorkspaceName(uri);
    return workspaceName ? this.removeWorkspacePrefix(uri, workspaceName) : uri;
  },
};

/** Multi-workspace file system router */
export class MultiWorkspaceFileSystem {
  private workspaceMap: Map<string, Workspace<WorkspaceInitMultiple>>;
  private defaultWorkspace: Workspace<WorkspaceInitMultiple>;

  constructor(workspaces: Workspace<WorkspaceInitMultiple>[]) {
    this.workspaceMap = new Map(workspaces.map((w) => [w.name, w]));
    this.defaultWorkspace = workspaces[0]; // Use first workspace for root files
  }

  private resolveWorkspaceAndPath(
    uri?: string
  ): [Workspace<WorkspaceInitMultiple>, string] {
    if (!uri) return [this.defaultWorkspace, "/"];

    if (WorkspaceURI.hasWorkspacePrefix(uri)) {
      const workspaceName = WorkspaceURI.extractWorkspaceName(uri);
      if (workspaceName) {
        const workspace = this.workspaceMap.get(workspaceName);
        if (workspace) {
          const originalPath = WorkspaceURI.removeWorkspacePrefix(
            uri,
            workspaceName
          );
          return [workspace, originalPath];
        }
      }
    }

    // Default to first workspace for root-level files
    return [this.defaultWorkspace, uri];
  }

  /** Create delegating file system method to the correct workspace */
  private createFSMethod<T extends keyof Workspace<WorkspaceInit>["fs"]>(
    methodName: T
  ): Workspace<WorkspaceInit>["fs"][T] {
    return ((uri: string, ...restArgs: unknown[]) => {
      const [workspace, actualPath] = this.resolveWorkspaceAndPath(uri);
      const method = workspace.fs[methodName];
      if (typeof method === "function") {
        return method.call(workspace.fs, actualPath, ...restArgs);
      }
      return undefined;
    }) as Workspace<WorkspaceInit>["fs"][T];
  }

  /** Create virtual workspace for multi-workspace setup */
  createVirtualWorkspace(): Workspace<WorkspaceInit> {
    const virtualWorkspace: Workspace<WorkspaceInit> = {
      // Static identifier for debugging/logging - not a real workspace
      name: "multi-workspace",

      fs: {
        // These methods use createFSMethod() to route calls to the correct real workspace
        readTextFile: this.createFSMethod("readTextFile"),
        readDirectory: this.createFSMethod("readDirectory"),
        stat: this.createFSMethod("stat"),
        readFile: this.createFSMethod("readFile"),
        writeFile: this.createFSMethod("writeFile"),
        createDirectory: this.createFSMethod("createDirectory"),
        copy: this.createFSMethod("copy"),
        delete: this.createFSMethod("delete"),
        rename: this.createFSMethod("rename"),

        // Special handling for methods that need custom logic
        walk: (): AsyncIterable<[string, FileSystemEntryType]> => {
          const [workspace] = this.resolveWorkspaceAndPath();
          if (workspace.fs.walk) {
            return workspace.fs.walk();
          }
          // Return empty iterator to satisfy TypeScript language service expectations
          return { async *[Symbol.asyncIterator]() {} };
        },

        watch: ((
          uri: string,
          options?: { recursive: boolean },
          callback?: FileSystemWatchHandle
        ) => {
          const [workspace, actualPath] = this.resolveWorkspaceAndPath(uri);

          // Handle both 2 and 3 parameter signatures
          if (typeof options === "function" && !callback) {
            callback = options;
            options = undefined;
          }

          if (workspace.fs.watch && typeof callback === "function") {
            return options
              ? workspace.fs.watch(actualPath, options, callback)
              : workspace.fs.watch(actualPath, callback);
          }
          // Return no-op dispose function if watch unavailable
          return () => {};
        }) as Workspace<WorkspaceInit>["fs"]["watch"],
      },

      // Routes document opening to the correct workspace
      _openTextDocument: async (
        uri: string,
        editor?: monacoNS.editor.ICodeEditor,
        selectionOrPosition?: monacoNS.IRange | monacoNS.IPosition
      ) => {
        const [workspace, actualPath] = this.resolveWorkspaceAndPath(uri);
        return workspace._openTextDocument(
          actualPath,
          editor,
          selectionOrPosition
        );
      },

      // No-op: Monaco is already initialized once in initMultiWorkspace() for all real workspaces
      setupMonaco: () => {},
      // This virtual workspace intentionally only implements the subset
      // of properties that Monaco/TypeScript worker actually uses (fs methods, _openTextDocument, setupMonaco).
      // It's a proxy/router, not a complete workspace, so missing properties like _monaco, _history, etc. is expected.
    } as any;

    return virtualWorkspace;
  }
}

/** Create a virtual workspace that can handle multiple workspaces */
export function createMultiWorkspaceFileSystem(
  workspaces: Workspace<WorkspaceInitMultiple>[]
): Workspace<WorkspaceInit> {
  const router = new MultiWorkspaceFileSystem(workspaces);
  return router.createVirtualWorkspace();
}
