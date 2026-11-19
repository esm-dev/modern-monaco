import type { HighlighterCore, LanguageInput, RegexEngine, ThemeInput, ThemeRegistration } from "@shikijs/core";
import { createHighlighterCore } from "@shikijs/core";
import { createOnigurumaEngine, getDefaultWasmLoader, setDefaultWasmLoader } from "@shikijs/engine-oniguruma";
import { version as tmGrammarsVersion } from "../node_modules/tm-grammars/package.json";
import { version as tmThemesVersion } from "../node_modules/tm-themes/package.json";

// ! external modules, don't remove the `.js` extension
import { cache } from "./cache.js";
import { isPlainObject } from "./util.js";

export interface GrammarInfo {
  name: string;
  scopeName?: string;
  aliases?: string[];
  embedded?: string[];
  embeddedIn?: string[];
  injectTo?: string[];
}

const grammars: GrammarInfo[] = SHIKI_GRAMMARS;
const themes: Map<string, ThemeRegistration> = new Map();
const shikiThemeIds = new Set(SHIKI_THEMES);

export interface ShikiInitOptions {
  /**
   * @deprecated Use `defaultTheme` instead.
   */
  theme?: string | URL | ThemeInput;
  defaultTheme?: string | URL | ThemeInput;
  themes?: (string | URL | ThemeInput)[];
  langs?: (string | URL | LanguageInput)[];
  cdn?: string;
  engine?: RegexEngine | Promise<RegexEngine>;
}

export interface Highlighter extends HighlighterCore {
  loadThemeFromCDN(name: string): Promise<void>;
  loadGrammarFromCDN(...ids: string[]): Promise<void>;
}

/** Register custom grammar metadata in the shared grammar catalogue. */
export function registerGrammarInfo(lang: unknown): void {
  if (!lang || typeof lang !== "object") {
    return;
  }
  if (Array.isArray(lang)) {
    lang.forEach(registerGrammarInfo);
    return;
  }
  if ("default" in lang && (lang as any).default && typeof (lang as any).default === "object") {
    registerGrammarInfo((lang as any).default);
    return;
  }
  const g = lang as GrammarInfo;
  if (typeof g.name !== "string" || !g.name) {
    return;
  }
  const existing = grammars.find((item) => item.name === g.name);
  if (!existing) {
    const info: GrammarInfo = { name: g.name };
    if (g.scopeName) info.scopeName = g.scopeName;
    if (g.aliases?.length) info.aliases = [...g.aliases];
    if (g.embedded?.length) info.embedded = [...g.embedded];
    if (g.injectTo?.length) info.injectTo = [...g.injectTo];
    grammars.push(info);
  } else if (g.aliases?.length) {
    const aliases = new Set([...(existing.aliases ?? []), ...g.aliases]);
    existing.aliases = [...aliases];
  }
}

async function resolveLanguageInput(input: LanguageInput): Promise<any> {
  const resolved = typeof input === "function" ? await input() : await input;
  registerGrammarInfo(resolved);
  return resolved;
}

/** Ensure requested themes and languages are loaded on an existing highlighter. */
export async function ensureShikiResources(
  highlighter: Highlighter,
  { defaultTheme, theme, themes: themeList = [], langs: languages, cdn }: Pick<
    ShikiInitOptions,
    "defaultTheme" | "theme" | "themes" | "langs" | "cdn"
  > = {},
): Promise<Highlighter> {
  if (theme) defaultTheme = theme;
  const loadedThemes = new Set(highlighter.getLoadedThemes());
  const themeInputs: (string | URL | ThemeInput)[] = [];
  for (const t of new Set(defaultTheme ? [defaultTheme, ...themeList] : themeList)) {
    if (typeof t === "string" && !isUrlOrPathname(t)) {
      const normalized = normalizeThemeId(t);
      if (loadedThemes.has(t) || loadedThemes.has(normalized)) continue;
    }
    themeInputs.push(t);
  }

  const loadedLangs = new Set(highlighter.getLoadedLanguages());
  const langInputs: LanguageInput[] = [];
  const seenLangs = new Set<string>();
  for (const l of languages ?? []) {
    if (["plaintext", "text"].includes(l as string)) {
      continue;
    }
    if (typeof l === "string" || l instanceof URL) {
      const g = typeof l === "string" && !isUrlOrPathname(l) ? getGrammarInfo(l) : undefined;
      const key = g?.name ?? l.toString();
      if (!seenLangs.has(key) && !loadedLangs.has(key)) {
        if (g?.embedded) {
          for (const id of g.embedded) {
            if (!seenLangs.has(id) && !loadedLangs.has(id)) {
              langInputs.push(loadTMGrammar(id, cdn));
              seenLangs.add(id);
            }
          }
        }
        langInputs.push(loadTMGrammar(g?.name ?? l, cdn));
        seenLangs.add(key);
      }
    } else if (isPlainObject(l) || typeof l === "function") {
      const name = isPlainObject(l) && typeof (l as any).name === "string" ? (l as any).name : undefined;
      if (name) {
        registerGrammarInfo(l);
        if (loadedLangs.has(name)) continue;
      }
      langInputs.push(resolveLanguageInput(l));
    }
  }

  const tasks: Promise<void>[] = [];
  if (themeInputs.length > 0) {
    tasks.push(
      Promise.all(themeInputs.map((t) => parseThemeInput(t, cdn))).then((resolved) => {
        const toLoad = resolved.filter((t): t is ThemeInput => Boolean(t));
        return toLoad.length > 0 ? highlighter.loadTheme(...toLoad) : undefined;
      }),
    );
  }
  if (langInputs.length > 0) {
    tasks.push(
      Promise.all(langInputs).then((resolved) => {
        const toLoad = resolved.filter((l) => {
          const name = isPlainObject(l) && typeof (l as any).name === "string" ? (l as any).name : undefined;
          return !name || !highlighter.getLoadedLanguages().includes(name);
        });
        return toLoad.length > 0 ? highlighter.loadLanguage(...toLoad) : undefined;
      }),
    );
  }
  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
  return highlighter;
}

/** Initialize shiki with the given options. */
export async function initShiki({
  defaultTheme,
  theme,
  themes = [],
  langs: languages,
  cdn,
  engine = createOnigurumaEngine(getDefaultWasmLoader()),
}: ShikiInitOptions = {}): Promise<Highlighter> {
  const langs: LanguageInput[] = [];

  if (languages?.length) {
    const set = new Set<string>();
    languages.forEach((l) => {
      if (["plaintext", "text"].includes(l as string)) {
        return;
      }
      if (typeof l === "string" || l instanceof URL) {
        const g = typeof l === "string" && !isUrlOrPathname(l) ? getGrammarInfo(l) : undefined;
        const key = g?.name ?? l.toString();
        if (!set.has(key)) {
          if (g?.embedded) {
            for (const id of g.embedded) {
              if (!set.has(id)) {
                langs.push(loadTMGrammar(id, cdn));
                set.add(id);
              }
            }
          }
          langs.push(loadTMGrammar(g?.name ?? l, cdn));
          set.add(key);
        }
      } else if (isPlainObject(l) || typeof l === "function") {
        langs.push(resolveLanguageInput(l));
      }
    });
  }

  /* Backwards-compatibility for deprecated `theme` param */
  if (theme) defaultTheme = theme;
  if (!defaultTheme && themes.length === 0) {
    defaultTheme = "vitesse-dark";
  }
  const themesToLoad = new Set(defaultTheme ? [defaultTheme, ...themes] : themes);

  const highlighterCore = await createHighlighterCore({
    langs,
    themes: await Promise.all([...themesToLoad].map((t) => parseThemeInput(t, cdn))),
    engine,
  });

  const loadingThemes = new Map<string, Promise<void>>();
  const loadingGrammars = new Map<string, Promise<void>>();

  const loadThemeFromCDN = (themeName: string): Promise<void> => {
    const normalized = isUrlOrPathname(themeName) ? themeName : normalizeThemeId(themeName);
    if (highlighterCore.getLoadedThemes().includes(themeName) || highlighterCore.getLoadedThemes().includes(normalized)) {
      return Promise.resolve();
    }
    let promise = loadingThemes.get(normalized);
    if (!promise) {
      promise = highlighterCore.loadTheme(loadTMTheme(themeName, cdn)).finally(() => {
        loadingThemes.delete(normalized);
      });
      loadingThemes.set(normalized, promise);
    }
    return promise;
  };

  const loadGrammarFromCDN = async (...ids: string[]): Promise<void> => {
    const promises: Promise<void>[] = [];
    for (const rawId of ids) {
      if (["plaintext", "text"].includes(rawId)) {
        continue;
      }
      const id = isUrlOrPathname(rawId) ? rawId : (resolveLanguage(rawId) ?? rawId);
      if (highlighterCore.getLoadedLanguages().includes(id)) {
        continue;
      }
      let promise = loadingGrammars.get(id);
      if (!promise) {
        promise = highlighterCore.loadLanguage(loadTMGrammar(id, cdn)).finally(() => {
          loadingGrammars.delete(id);
        });
        loadingGrammars.set(id, promise);
      }
      promises.push(promise);
    }
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  };

  Object.assign(highlighterCore, {
    loadThemeFromCDN,
    loadGrammarFromCDN,
  });
  return highlighterCore as unknown as Highlighter;
}

/** Parses a theme, loading via CDN if needed. */
async function parseThemeInput(theme: string | URL | ThemeInput, cdn?: string) {
  if (typeof theme === "string" || theme instanceof URL) {
    return await loadTMTheme(theme, cdn);
  } else if (isPlainObject(theme) || typeof theme === "function") {
    return theme;
  }
}

function normalizeThemeId(src: string): string {
  return src.replace(/\s+/g, "-").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Load a TextMate theme from the given source. */
function loadTMTheme(src: string | URL, cdn = "https://esm.sh") {
  if (isUrlOrPathname(src)) {
    return cache.fetch(src).then((res) => res.json());
  }
  // check if it's a built-in registered theme
  if (themes.has(src)) {
    return themes.get(src)!;
  }
  src = normalizeThemeId(src);
  if (themes.has(src)) {
    return themes.get(src)!;
  }
  if (!shikiThemeIds.has(src)) {
    throw new Error(
      `Invalid theme ID: ${src}, please ensure the theme ID is one of the following: ${Array.from(shikiThemeIds.keys()).join(", ")}`,
    );
  }
  const url = new URL(`/tm-themes@${tmThemesVersion}/themes/${src}.json`, cdn);
  return cache.fetch(url).then((res) => res.json());
}

/** Load a TextMate grammar from the given source. */
function loadTMGrammar(src: string | URL, cdn = "https://esm.sh") {
  if (isUrlOrPathname(src)) {
    return cache.fetch(src).then((res) => res.json());
  }
  const g = getGrammarInfo(src);
  if (g) {
    const url = new URL(`/tm-grammars@${tmGrammarsVersion}/grammars/${g.name}.json`, cdn);
    return cache.fetch(url).then((res) => res.json());
  }
  throw new Error(`Unsupported grammar source: ${src}`);
}

/** Get grammar info from a language name or alias (case-insensitive). */
export function getGrammarInfo(nameOrAlias: string): GrammarInfo | undefined {
  const key = nameOrAlias.toLowerCase();
  return grammars.find((g) => g.name.toLowerCase() === key || g.aliases?.some((a) => a.toLowerCase() === key));
}

/** Resolve a language name or alias to its canonical grammar ID. */
export function resolveLanguage(nameOrAlias: string): string | undefined {
  return getGrammarInfo(nameOrAlias)?.name;
}

/** Get grammar info from the given path. */
export function getGrammarInfoFromPath(path: string): GrammarInfo | undefined {
  const idx = path.lastIndexOf(".");
  if (idx > 0) {
    const ext = path.slice(idx + 1);
    return getGrammarInfo(ext);
  }
}

/** @deprecated Use `getGrammarInfoFromPath` instead. */
export const getGarmmarInfoFromPath = getGrammarInfoFromPath;

/** Get language ID from the given path. */
export function getLanguageIdFromPath(path: string): string | undefined {
  return getGrammarInfoFromPath(path)?.name;
}

/** Get the extension name from the given language ID. */
export function getExtnameFromLanguageId(language: string): string | undefined {
  const g = grammars.find((g) => g.name === language);
  if (g) {
    return g.aliases?.[0] ?? g.name;
  }
  return undefined;
}

function isUrlOrPathname(src: string | URL): src is URL {
  return src instanceof URL
    || (typeof src === "string" && (src.startsWith("https://") || src.startsWith("http://") || src.startsWith("/")));
}

async function loadOnigWasm(imports?: WebAssembly.Imports) {
  const url = new URL("./onig.wasm", import.meta.url);
  if (url.protocol === "file:") {
    const fs = (globalThis as any).process?.getBuiltinModule?.("node:fs/promises");
    if (fs) {
      return WebAssembly.instantiate(await fs.readFile(url), imports);
    }
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch onig.wasm from ${url}: ${res.status} ${res.statusText}`);
  }
  if (
    typeof WebAssembly.instantiateStreaming === "function"
    && res.headers.get("content-type")?.includes("application/wasm")
  ) {
    return WebAssembly.instantiateStreaming(res, imports);
  }
  return WebAssembly.instantiate(await res.arrayBuffer(), imports);
}

setDefaultWasmLoader(loadOnigWasm);

// `SHIKI_GRAMMARS` and `SHIKI_THEMES` are defined at build time
declare const SHIKI_GRAMMARS: { name: string; aliases?: string[]; embedded?: string[]; injectTo?: string[] }[];
declare const SHIKI_THEMES: string[];

export * from "./render.ts";
export * from "./shiki-monaco.ts";
export { grammars, setDefaultWasmLoader, themes };
