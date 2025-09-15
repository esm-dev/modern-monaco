import type monacoNS from "monaco-editor-core";
import { start } from "monaco-editor-core/esm/vs/editor/editor.worker.start";

export interface MonacoLanguageWorker<CreateData extends object, Host = undefined> {
  new(ctx: monacoNS.worker.IWorkerContext<Host>, createData: CreateData);
}

export function initializeWorker<CreateData extends object, Host = undefined>(Worker: MonacoLanguageWorker<CreateData, Host>): void {
  self.onmessage = (msg: MessageEvent<CreateData>) => {
    start((ctx: monacoNS.worker.IWorkerContext<Host>) => new Worker(ctx, msg.data));
  };
}

export { start };
