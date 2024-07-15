import type { HighlighterCore, LanguageInput, ThemeInput } from "@shikijs/core";
import type { VFS } from "./vfs.ts";
import { createHighlighterCore, setDefaultWasmLoader } from "@shikijs/core";
import { version as tmGrammarsVersion } from "../node_modules/tm-grammars/package.json";
import { version as tmThemesVersion } from "../node_modules/tm-themes/package.json";

// ! external modules, don't remove the `.js` extension
import { cache } from "./cache.js";
import { isPlainObject } from "./util.js";

// @ts-expect-error `TM_GRAMMARS` is defined at build time
const tmGrammars: { name: string; aliases?: string[]; embedded?: string[]; injectTo?: string[] }[] = TM_GRAMMARS;
// @ts-expect-error `TM_THEMES` is defined at build time
const tmThemes: Set<string> = new Set(TM_THEMES);

const vitesseDark = "vitesse-dark";

export interface ShikiInitOptions {
  langs?: (string | URL | LanguageInput)[];
  theme?: string | URL | ThemeInput;
  downloadCDN?: string;
}

export interface Highlighter extends HighlighterCore {
  loadThemeFromCDN(name: string): Promise<void>;
  loadLanguageFromCDN(name: string): Promise<void>;
}

/** Initialize shiki with the given options. */
export async function initShiki({
  theme = vitesseDark,
  langs: languages,
  downloadCDN,
}: ShikiInitOptions = {}): Promise<Highlighter> {
  const langs: LanguageInput[] = [];
  const themes: ThemeInput[] = [];

  if (languages?.length > 0) {
    languages.forEach((input) => {
      if (typeof input === "string" || input instanceof URL) {
        const g = tmGrammars.find((g) => g.name === input);
        if (g?.embedded) {
          langs.push(...g.embedded.map((id) => loadTMGrammar(id, downloadCDN)));
        }
        langs.push(loadTMGrammar(input, downloadCDN));
      } else if (isPlainObject(input)) {
        langs.push(input);
      }
    });
  }

  if (typeof theme === "string" || theme instanceof URL) {
    themes.push(await loadTMTheme(theme, downloadCDN));
  } else if (isPlainObject(theme)) {
    themes.push(theme);
  }

  const highlighterCore = await createHighlighterCore({ langs, themes });
  Object.assign(highlighterCore, {
    loadThemeFromCDN: (themeName: string) => highlighterCore.loadTheme(loadTMTheme(themeName, downloadCDN)),
    loadLanguageFromCDN: (lang: string) => highlighterCore.loadLanguage(loadTMGrammar(lang, downloadCDN)),
  });
  return highlighterCore as unknown as Highlighter;
}

/** Load a TextMate theme from the given source. */
function loadTMTheme(src: string | URL, cdn = "https://esm.sh") {
  if (src === vitesseDark) {
    // @ts-expect-error `VITESSE_DARK` is defined at build time
    return VITESSE_DARK;
  }
  const hasTheme = typeof src === "string" && tmThemes.has(src);
  if (!hasTheme) {
    const s = src as string;
    if (!s.startsWith("http://") && !s.startsWith("https://")) {
      throw new Error(`Theme "${src}" not found`);
    }
  }
  const url = hasTheme ? new URL(`/tm-themes@${tmThemesVersion}/themes/${src}.json`, cdn) : src;
  return cache.fetch(url).then((res) => res.json());
}

/** Load a TextMate grammar from the given source. */
function loadTMGrammar(src: string | URL, cdn = "https://esm.sh") {
  if (typeof src === "string") {
    const g = tmGrammars.find(g => g.name === src);
    if (!g) {
      if (src.startsWith("http://") || src.startsWith("https://")) {
        return cache.fetch(src).then((res) => res.json());
      } else {
        throw new Error(`Grammar "${src}" not found`);
      }
    }
    const url = new URL(`/tm-grammars@${tmGrammarsVersion}/grammars/${g.name}.json`, cdn);
    return cache.fetch(url).then((res) => res.json()).then((grammar) => ({
      injectTo: g.injectTo,
      ...grammar,
    }));
  }
  return cache.fetch(src).then((res) => res.json());
}

/** Get grammar Info from file path. */
export function getGarmmarInfoFromPath(
  path: string,
): { name: string; aliases?: string[]; embedded?: string[]; injectTo?: string[] } | undefined {
  const idx = path.lastIndexOf(".");
  if (idx > 0) {
    const ext = path.slice(idx + 1);
    return tmGrammars.find((g) => g.name === ext || g.aliases?.includes(ext));
  }
}

/** Get language ID from file path. */
export function getLanguageIdFromPath(path: string): string | undefined {
  return getGarmmarInfoFromPath(path)?.name;
}

/** Get all grammar IDs in the given VFS. */
export const getLanguageIdsInVFS = async (vfs: VFS) => {
  const grammars = new Set<string>();
  try {
    const list = await vfs.ls();
    for (const path of list) {
      const g = getGarmmarInfoFromPath(path);
      if (g) {
        grammars.add(g.name);
        if (g.embedded) {
          g.embedded.forEach((id) => grammars.add(id));
        }
      }
    }
  } catch {
    // ignore vfs error
  }
  return Array.from(grammars);
};

export * from "./render.ts";
export * from "./shiki-monaco.ts";
export { setDefaultWasmLoader, tmGrammars, tmThemes };
