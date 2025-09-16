import { lazy } from "modern-monaco";
import { workspace } from "./workspace.ts";

// initialize the editor lazily
lazy({ workspace });
