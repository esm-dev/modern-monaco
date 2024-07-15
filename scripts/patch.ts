// replace the default command history storage (which is in-memory) of Monaco Editor with a browser localStorage-based one
const commandHistoryStorage = `{
  get: (key, _scope) => localStorage.getItem(key),
  getNumber: (key, _scope, def) => Number(localStorage.getItem(key)) || def,
  store: (key, value) => localStorage.setItem(key, String(value)),
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
