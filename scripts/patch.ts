// replace the default command history storage (which is in-memory) of Monaco Editor with a browser localStorage-based one
const commandHistoryStorage = `{
  get: (key, _scope) => localStorage.getItem('monaco:' + key),
  getNumber: (key, _scope, def) => Number(localStorage.getItem('monaco:' + key)) || def,
  store: (key, value) => localStorage.setItem('monaco:' + key, String(value)),
  onWillSaveState: (cb) => {
    window.addEventListener("beforeunload", () => {
      cb({ reason: WillSaveStateReason.SHUTDOWN });
    });
  },
};
`;
const path = "node_modules/monaco-editor-core/esm/vs/platform/quickinput/browser/commandsQuickAccess.js";
const js = await Deno.readTextFile(path);
const arr = js.split("this.storageService = storageService;");
if (arr.length === 2) {
  await Deno.writeTextFile(path, arr[0] + "// Added by esm-monaco\nthis.storageService = " + commandHistoryStorage + arr[1]);
}

// add keybindings for quick pick navigation on macOS
const registerQuickPickCommandAndKeybindingRules = `
// Added by esm-monaco
if (isMacintosh) {
  registerQuickPickCommandAndKeybindingRule({ id: 'quickInput.Next', primary: 256 /* KeyMod.WinCtrl */ + 44 /* KeyCode.N */, handler: focusHandler(QuickPickFocus.Next) });
  registerQuickPickCommandAndKeybindingRule({ id: 'quickInput.Previous', primary: 256 /* KeyMod.WinCtrl */ + 46 /* KeyCode.P */, handler: focusHandler(QuickPickFocus.Previous) });
}
`;
const path2 = "node_modules/monaco-editor-core/esm/vs/platform/quickinput/browser/quickInputActions.js";
const js2 = await Deno.readTextFile(path2);
if (!js2.includes(registerQuickPickCommandAndKeybindingRules)) {
  await Deno.writeTextFile(path2, js2 + registerQuickPickCommandAndKeybindingRules);
}
