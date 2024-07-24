/** The import maps follow the spec at https://wicg.github.io/import-maps/. */
export interface ImportMap {
  $baseURL: string;
  $src?: string;
  $support?: boolean;
  imports: Record<string, string>;
  scopes: Record<string, Record<string, string>>;
}

/** Create a blank import map. */
export function createBlankImportMap(baseURL?: string): ImportMap {
  return {
    $baseURL: new URL(baseURL ?? ".", "file:///").href,
    $support: globalThis.HTMLScriptElement?.supports?.("importmap"),
    imports: {},
    scopes: {},
  };
}

/** Check if the import map is blank. */
export function isBlankImportMap(importMap: ImportMap) {
  if (!importMap) {
    return true;
  }
  if (!isObject(importMap.imports) && !isObject(importMap.scopes)) {
    return true;
  }
  return Object.keys(importMap.imports ?? {}).length + Object.keys(importMap.scopes ?? {}).length === 0;
}

/** Validate the given import map. */
export function importMapFrom(v: any, baseURL?: string): ImportMap {
  const im = createBlankImportMap(baseURL);
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

/** Parse the import map from JSON. */
export function parseImportMapFromJson(json: string, baseURL?: string): ImportMap {
  const importMap: ImportMap = {
    $baseURL: new URL(baseURL ?? ".", "file:///").href,
    $support: globalThis.HTMLScriptElement?.supports?.("importmap"),
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

/** Parse the import map from Html. */
export function parseImportMapFromHtml(html: string, baseURL?: string): ImportMap {
  const tplEl = document.createElement("template");
  tplEl.innerHTML = html;
  const scriptEl: HTMLScriptElement | null = tplEl.content.querySelector("script[type='importmap']");
  if (scriptEl) {
    return parseImportMapFromJson(scriptEl.textContent!, baseURL);
  }

  return createBlankImportMap(baseURL);
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
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
