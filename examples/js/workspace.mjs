import { Workspace } from "modern-monaco";
import { files } from "./files.mjs";

export const workspace = new Workspace({
  name: "test",
  initialFiles: {
    ...files,
    "src/greeting.ts": 'export const message = "Hello test!" as const;',
  },
  entryFile: "index.html",
});

export const workspaceWithBrowserHistory = new Workspace({
  name: "browser-history",
  initialFiles: {
    ...files,
    "src/greeting.ts": 'export const message = "Hello browser history!" as const;',
  },
  entryFile: "index.html",
  browserHistory: true,
});

export const secondaryWorkspace = new Workspace({
  name: "secondary",
  initialFiles: {
    ...files,
    "src/greeting.ts": 'export const message = "Hello secondary workspace!" as const;',
    "src/App.tsx": files["src/App.tsx"],
  },
  entryFile: "index.html",
});
