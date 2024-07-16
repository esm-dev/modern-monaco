// [path-1] replace the default command history storage (which is in-memory) of Monaco Editor with a browser localStorage-based one
const commandHistoryStorage = `{
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
    await Deno.writeTextFile(path, arr[0] + "// Added by esm-monaco\nthis.storageService = " + commandHistoryStorage + arr[1]);
    console.log("Patched", path.slice("node_modules/".length));
  }
}

// [patch-4] add keybindings for quick pick navigation on macOS
const registerQuickPickCommandAndKeybindingRules = `
// Added by esm-monaco
if (isMacintosh) {
  registerQuickPickCommandAndKeybindingRule({ id: 'quickInput.Next', primary: 256 /* KeyMod.WinCtrl */ + 44 /* KeyCode.N */, handler: focusHandler(QuickPickFocus.Next) });
  registerQuickPickCommandAndKeybindingRule({ id: 'quickInput.Previous', primary: 256 /* KeyMod.WinCtrl */ + 46 /* KeyCode.P */, handler: focusHandler(QuickPickFocus.Previous) });
}
`;
{
  const path = "node_modules/monaco-editor-core/esm/vs/platform/quickinput/browser/quickInputActions.js";
  const js = await Deno.readTextFile(path);
  if (!js.includes(registerQuickPickCommandAndKeybindingRules)) {
    await Deno.writeTextFile(path, js + registerQuickPickCommandAndKeybindingRules);
    console.log("Patched", path.slice("node_modules/".length));
  }
}

// [path-3] fix type definitions for createModel and getModel to accept `string | URL | Uri` type for the `uri` parameter
{
  const path = "node_modules/monaco-editor-core/esm/vs/editor/editor.api.d.ts";
  const changes = [
    [
      "export function createModel(value: string, language?: string, uri?: Uri): ITextModel;",
      "export function createModel(value: string, language?: string, uri?: string | URL | Uri): ITextModel;",
    ],
    [
      "export function getModel(uri: Uri): ITextModel | null;",
      "export function getModel(uri: string | URL | Uri): ITextModel | null;",
    ],
  ];
  let dts = await Deno.readTextFile(path);
  let replaced = false;
  for (const [search, replace] of changes) {
    if (!dts.includes(replace)) {
      dts = dts.replace(search, replace);
      replaced = true;
    }
  }
  if (replaced) {
    await Deno.writeTextFile(path, dts);
    console.log("Patched", path.slice("node_modules/".length));
  }
}

// [path-4] fix type definitions for createModel and getModel to accept `string | URL | Uri` type for the `uri` parameter
{
  const path = "node_modules/monaco-editor-core/esm/vs/editor/editor.api.d.ts";
  const dts = await Deno.readTextFile(path);
  const appendTS = "\nexport * from './monaco.ui';";
  if (!dts.includes(appendTS)) {
    await Deno.writeTextFile(path, dts + appendTS);
  }
  const pathOrgi = "types/monaco.ui.d.ts";
  const pathDest = "node_modules/monaco-editor-core/esm/vs/editor/monaco.ui.d.ts";
  const dts2 = await Deno.readTextFile(pathOrgi);
  await Deno.writeTextFile(pathDest, dts2.replace("./monaco.d.ts", "./editor.api.d.ts"));
  console.log("Patched", pathDest.slice("node_modules/".length));
}

// [path-5] fix the issue of `maxDigitWidth` not being set correctly in SSR mode
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

// [path-6] fix folding icon size
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
