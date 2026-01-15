import type { HighlighterCore, LanguageInput, RegexEngine, ThemeInput, ThemeRegistration } from "@shikijs/core";
import { createHighlighterCore } from "@shikijs/core";
import { createOnigurumaEngine, getDefaultWasmLoader, setDefaultWasmLoader } from "@shikijs/engine-oniguruma";
import { version as tmGrammarsVersion } from "../node_modules/tm-grammars/package.json";
import { version as tmThemesVersion } from "../node_modules/tm-themes/package.json";

// ! external modules, don't remove the `.js` extension
import { cache } from "./cache.js";
import { isPlainObject } from "./util.js";

const grammars = SHIKI_GRAMMARS;
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
        if (!set.has(l.toString())) {
          const g = grammars.find((g) => g.name === l);
          if (g?.embedded) {
            langs.push(...g.embedded.map((id) => loadTMGrammar(id, cdn)));
          }
          langs.push(loadTMGrammar(l, cdn));
          set.add(l.toString());
        }
      } else if (isPlainObject(l) || typeof l === "function") {
        langs.push(l);
      }
    });
  }

  /** Parses a theme, loading via CDN if needed */
  async function parseTheme(theme: string | URL | ThemeInput) {
    if (typeof theme === "string" || theme instanceof URL) {
      return await loadTMTheme(theme, cdn);
    } else if (isPlainObject(theme) || typeof theme === "function") {
      return theme;
    }
  }

  /* Backwards-compatibility for deprecated `theme` param */
  if (theme) defaultTheme = theme;
  if (!defaultTheme && themes.length === 0) {
    defaultTheme = "vitesse-dark";
  }
  const themesToLoad = new Set(themes);
  if (defaultTheme) {
    themesToLoad.add(defaultTheme);
  }

  const highlighterCore = await createHighlighterCore({
    langs,
    themes: await Promise.all([...themesToLoad].map(parseTheme)),
    engine,
  });
  Object.assign(highlighterCore, {
    loadThemeFromCDN: (themeName: string) => highlighterCore.loadTheme(loadTMTheme(themeName, cdn)),
    loadGrammarFromCDN: (...ids: string[]) => highlighterCore.loadLanguage(...ids.map(id => loadTMGrammar(id, cdn))),
  });
  return highlighterCore as unknown as Highlighter;
}

/** Load a TextMate theme from the given source. */
function loadTMTheme(src: string | URL, cdn = "https://esm.sh") {
  if (isURL(src)) {
    return cache.fetch(src).then((res) => res.json());
  }
  // check if it's a built-in registered theme
  if (themes.has(src)) {
    return themes.get(src)!;
  }
  src = src.replace(/\s+/g, "-").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
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
  if (isURL(src)) {
    return cache.fetch(src).then((res) => res.json());
  }
  const g = grammars.find(g => g.name === src);
  if (g) {
    const url = new URL(`/tm-grammars@${tmGrammarsVersion}/grammars/${g.name}.json`, cdn);
    return cache.fetch(url).then((res) => res.json());
  }
  throw new Error(`Unsupported grammar source: ${src}`);
}

/** Get grammar Info from the given path. */
export function getGarmmarInfoFromPath(path: string): {
  name: string;
  aliases?: string[];
  embedded?: string[];
  injectTo?: string[];
} | undefined {
  const idx = path.lastIndexOf(".");
  if (idx > 0) {
    const ext = path.slice(idx + 1);
    return grammars.find((g) => g.name === ext || g.aliases?.includes(ext));
  }
}

/** Get language ID from the given path. */
export function getLanguageIdFromPath(path: string): string | undefined {
  return getGarmmarInfoFromPath(path)?.name;
}

/** Get the extension name from the given language ID. */
export function getExtnameFromLanguageId(language: string): string | undefined {
  const g = grammars.find((g) => g.name === language);
  if (g) {
    return g.aliases?.[0] ?? g.name;
  }
  return undefined;
}

function isURL(src: string | URL): src is URL {
  return src instanceof URL
    || (typeof src === "string" && (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/")));
}

// `SHIKI_GRAMMARS` and `SHIKI_THEMES` are defined at build time
declare const SHIKI_GRAMMARS: { name: string; aliases?: string[]; embedded?: string[]; injectTo?: string[] }[];
declare const SHIKI_THEMES: string[];

export * from "./render.ts";
export * from "./shiki-monaco.ts";
export { grammars, setDefaultWasmLoader, themes };
