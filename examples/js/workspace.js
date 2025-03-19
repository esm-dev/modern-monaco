import { Workspace } from "modern-monaco";
import { files } from "./files.js";

export const workspace = new Workspace({
  name: "test",
  initialFiles: files,
  entryFile: "index.html",
});

export const workspaceWithBrowserHistory = new Workspace({
  name: "test",
  initialFiles: files,
  entryFile: "index.html",
  browserHistory: true,
});
