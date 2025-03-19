// [path-1] replace the default command history storage (which is in-memory) of Monaco Editor with a browser localStorage-based one
const commandHistoryStorageJs = `{
  get: (key, _scope, defaultValue) => localStorage.getItem('monaco:' + key) ?? defaultValue,
  getNumber: (key, _scope, defaultValue) => Number(localStorage.getItem('monaco:' + key) ?? defaultValue) || defaultValue,
  store: (key, value) => localStorage.setItem('monaco:' + key, String(value)),
  onWillSaveState: (callback) => {
    window.addEventListener('beforeunload', () => {
      callback({ reason: WillSaveStateReason.SHUTDOWN });
    });
  },
};
`;
{
  const path = "node_modules/monaco-editor-core/esm/vs/platform/quickinput/browser/commandsQuickAccess.js";
  const js = await Deno.readTextFile(path);
  const arr = js.split("this.storageService = storageService;");
  if (arr.length === 2) {
    await Deno.writeTextFile(path, arr[0] + "// Added by esm-monaco\nthis.storageService = " + commandHistoryStorageJs + arr[1]);
    console.log("Patched", path.slice("node_modules/".length));
  }
}

// [patch-4] add keybindings for quick pick navigation on macOS
const registerQuickPickCommandAndKeybindingRulesJS = `
// Added by esm-monaco
if (isMacintosh) {
  registerQuickPickCommandAndKeybindingRule({ id: 'quickInput.Next', primary: 256 /* KeyMod.WinCtrl */ + 44 /* KeyCode.N */, handler: focusHandler(QuickPickFocus.Next) });
  registerQuickPickCommandAndKeybindingRule({ id: 'quickInput.Previous', primary: 256 /* KeyMod.WinCtrl */ + 46 /* KeyCode.P */, handler: focusHandler(QuickPickFocus.Previous) });
}
`;
{
  const path = "node_modules/monaco-editor-core/esm/vs/platform/quickinput/browser/quickInputActions.js";
  const js = await Deno.readTextFile(path);
  if (!js.includes(registerQuickPickCommandAndKeybindingRulesJS)) {
    await Deno.writeTextFile(path, js + registerQuickPickCommandAndKeybindingRulesJS);
    console.log("Patched", path.slice("node_modules/".length));
  }
}

// [path-3] fix type definitions for createModel and getModel to accept `string | URL | Uri` type for the `uri` parameter
{
  const path = "node_modules/monaco-editor-core/esm/vs/editor/editor.api.d.ts";
  const diffs = [
    [
      "export function createModel(value: string, language?: string, uri?: Uri): ITextModel;",
      "export function createModel(value: string, language?: string, uri?: string | URL | Uri): ITextModel;",
    ],
    [
      "export function getModel(uri: Uri): ITextModel | null;",
      "export function getModel(uri: string | URL | Uri): ITextModel | null;",
    ],
  ];
  const addon = "\nexport * from './vscode';\n";
  let dts = await Deno.readTextFile(path);
  let patched = false;
  for (const [search, replace] of diffs) {
    if (!dts.includes(replace)) {
      dts = dts.replace(search, replace);
      patched = true;
    }
  }
  if (!dts.includes(addon)) {
    const pathOrgi = "types/vscode.d.ts";
    const pathDest = "node_modules/monaco-editor-core/esm/vs/editor/vscode.d.ts";
    await Deno.writeTextFile(pathDest, (await Deno.readTextFile(pathOrgi)).replace("./monaco.d.ts", "./editor.api.d.ts"));
    dts += addon;
    patched = true;
  }
  if (patched) {
    await Deno.writeTextFile(path, dts);
    console.log("Patched", path.slice("node_modules/".length));
  }
}

// [path-4] fix the issue of `maxDigitWidth` not being set correctly in SSR mode
{
  const path = "node_modules/monaco-editor-core/esm/vs/editor/common/config/editorOptions.js";
  const js = await Deno.readTextFile(path);
  const search = "maxDigitWidth: env.fontInfo.maxDigitWidth,";
  const replace = "maxDigitWidth: globalThis.__monaco_maxDigitWidth || env.fontInfo.maxDigitWidth,";
  if (!js.includes(replace)) {
    await Deno.writeTextFile(path, js.replace(search, replace));
    console.log("Patched", path.slice("node_modules/".length));
  }
}

// [path-5] fix folding icon size
{
  const path = "node_modules/monaco-editor-core/esm/vs/editor/contrib/folding/browser/folding.css";
  const css = await Deno.readTextFile(path);
  const search = "font-size: 140%;";
  const replace = "font-size: 100%;";
  if (css.includes(search)) {
    await Deno.writeTextFile(path, css.replace(search, replace));
    console.log("Patched", path.slice("node_modules/".length));
  }
}
