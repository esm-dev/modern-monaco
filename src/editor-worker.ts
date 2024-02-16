import type monacoNS from "monaco-editor-core";
import { initialize } from "monaco-editor-core/esm/vs/editor/editor.worker";

export interface LanguageWorker<D extends object> {
  new (ctx: monacoNS.worker.IWorkerContext, createData: D);
}

export function initializeWorker<W extends LanguageWorker<D>, D extends object>(Worker: W): void {
  globalThis.onmessage = () => {
    // Ignore first message in this case and initialize if not yet initialized
    initialize((ctx: monacoNS.worker.IWorkerContext, createData: D) => {
      return new Worker(ctx, createData);
    });
  };
}

export * from "monaco-editor-core/esm/vs/editor/editor.worker";
