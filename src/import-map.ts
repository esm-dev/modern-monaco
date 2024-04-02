/** The import maps follow the spec at https://wicg.github.io/import-maps/. */
export interface ImportMap {
  $src?: string;
  $support?: boolean;
  $baseURL: string;
  imports: Record<string, string>;
  scopes: Record<string, ImportMap["imports"]>;
}

/** Create a blank import map. */
export function blankImportMap(): ImportMap {
  return {
    $baseURL: "file:///",
    imports: {},
    scopes: {},
  };
}

/** Validate the given import map. */
export function toImportMap(v: any): ImportMap {
  const im = blankImportMap();
  if (isObject(v)) {
    const { imports, scopes } = v;
    if (isObject(imports)) {
      validateImports(imports);
      im.imports = imports as ImportMap["imports"];
    }
    if (isObject(scopes)) {
      validateScopes(scopes);
      im.scopes = scopes as ImportMap["scopes"];
    }
  }
  return im;
}

/** Check if the import map is blank. */
export function isBlank(importMap: ImportMap) {
  return Object.keys(importMap.imports).length + Object.keys(importMap.scopes).length === 0;
}

/** Resolve the specifier with the import map. */
export function resolve(importMap: ImportMap, specifier: string, containingFile: string): string {
  const { $baseURL, imports, scopes } = importMap;
  const { origin, pathname } = new URL(containingFile);
  const sameOriginScopes: [string, ImportMap["imports"]][] = [];
  for (const scopeName in scopes) {
    const scopeUrl = new URL(scopeName, $baseURL);
    if (scopeUrl.origin === origin) {
      sameOriginScopes.push([scopeUrl.pathname, scopes[scopeName]]);
    }
  }
  sameOriginScopes.sort(([a], [b]) => b.split("/").length - a.split("/").length);
  if (sameOriginScopes.length > 0) {
    for (const [scopePathname, scopeImports] of sameOriginScopes) {
      if (pathname.startsWith(scopePathname)) {
        const match = matchImports(specifier, scopeImports);
        if (match) {
          return match;
        }
      }
    }
  }
  if (origin === new URL($baseURL).origin) {
    const match = matchImports(specifier, imports);
    if (match) {
      return match;
    }
  }
  return specifier;
}

function matchImports(specifier: string, imports: ImportMap["imports"]) {
  if (specifier in imports) {
    return imports[specifier];
  }
  for (const [k, v] of Object.entries(imports)) {
    if (k.endsWith("/") && specifier.startsWith(k)) {
      return v + specifier.slice(k.length);
    }
  }
  return null;
}

/** Parse the import map from JSON. */
export function parseImportMapFromJson(json: string, baseURL?: string): ImportMap {
  const importMap: ImportMap = {
    $support: globalThis.HTMLScriptElement?.supports?.("importmap"),
    $baseURL: new URL(baseURL ?? ".", "file:///").href,
    imports: {},
    scopes: {},
  };
  const v = JSON.parse(json);
  if (isObject(v)) {
    const { imports, scopes } = v;
    if (isObject(imports)) {
      validateImports(imports);
      importMap.imports = imports as ImportMap["imports"];
    }
    if (isObject(scopes)) {
      validateScopes(scopes);
      importMap.scopes = scopes as ImportMap["scopes"];
    }
  }
  return importMap;
}

/** Load import maps from the root index.html or external json file in the VFS. */
export async function loadImportMapFromVFS(vfs: import("./vfs").VFS, verify?: (im: ImportMap) => ImportMap) {
  let src: string;
  try {
    const indexHtml = await vfs.readTextFile("index.html");
    const tplEl = document.createElement("template");
    tplEl.innerHTML = indexHtml;
    const scriptEl: HTMLScriptElement = tplEl.content.querySelector("script[type=\"importmap\"]");
    src = "file:///index.html";
    if (scriptEl) {
      if (scriptEl.src) {
        src = new URL(scriptEl.src, src).href;
      }
      const importMap = parseImportMapFromJson(
        scriptEl.src ? await vfs.readTextFile(scriptEl.src) : scriptEl.textContent,
      );
      importMap.$src = src;
      return verify?.(importMap) ?? importMap;
    }
  } catch (error) {
    // ignore error, fallback to a blank import map
    console.error(`Failed to load import map from "${src}":`, error.message);
  }
  const importMap = blankImportMap();
  importMap.$src = src;
  return verify?.(importMap) ?? importMap;
}

function validateImports(imports: Record<string, unknown>) {
  for (const [k, v] of Object.entries(imports)) {
    if (!v || typeof v !== "string") {
      delete imports[k];
    }
  }
}

function validateScopes(imports: Record<string, unknown>) {
  for (const [k, v] of Object.entries(imports)) {
    if (isObject(v)) {
      validateImports(v);
    } else {
      delete imports[k];
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v);
}
