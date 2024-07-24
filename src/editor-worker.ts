import type monacoNS from "monaco-editor-core";
import { initialize } from "monaco-editor-core/esm/vs/editor/editor.worker";

export interface MonacoLanguageWorker<Data extends object, Host = undefined> {
  new(ctx: monacoNS.worker.IWorkerContext<Host>, createData: Data);
}

export function initializeWorker<Data extends object, Host = undefined>(Worker: MonacoLanguageWorker<Data, Host>): void {
  globalThis.onmessage = () => {
    // Ignore first message in this case and initialize if not yet initialized
    initialize((ctx: monacoNS.worker.IWorkerContext<Host>, createData: Data) => new Worker(ctx, createData));
  };
}

export * from "monaco-editor-core/esm/vs/editor/editor.worker";
