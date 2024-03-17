import type { ThemeInput } from "@shikijs/core";
import type { LanguageInput, LanguageRegistration } from "@shikijs/core";
import type { VFS } from "./vfs";
import loadWasm from "@shikijs/core/wasm-inlined";
import { getHighlighterCore } from "@shikijs/core";
import { version as tmGrammarsVersion } from "../node_modules/tm-grammars/package.json";
import { version as tmThemesVersion } from "../node_modules/tm-themes/package.json";
import { cache } from "./cache";

const defaultTheme = "vitesse-dark";
const regHttpURL = /^https?:\/\//;

// @ts-expect-error `TM_GRAMMARS` is defined at build time
const tmGrammars: { name: string; aliases?: string[]; embedded?: [] }[] = TM_GRAMMARS;
// @ts-expect-error `TM_THEMES` is defined at build time
const tmThemes: Set<string> = new Set(TM_THEMES);

export const grammarRegistry = new Map(tmGrammars.map((g) => [g.name, g]));

export interface ShikiInitOptions {
  theme?: string | { name: string };
  preloadGrammars?: string[];
  customGrammars?: { name: string; scopeName: string; embeddedLanguages?: Record<string, string> }[];
}

/** Initialize shiki with the given options. */
export async function initShiki({
  theme = defaultTheme,
  preloadGrammars,
  customGrammars,
}: ShikiInitOptions) {
  const langs: LanguageInput = [];
  const themes: ThemeInput[] = [];

  if (preloadGrammars?.length > 0) {
    langs.push(
      ...await Promise.all(
        Array.from(new Set(preloadGrammars)).map((src) =>
          regHttpURL.test(src) ? { src } : tmGrammars.find((g) => g.name === src || g.aliases?.includes(src))
        ).filter(Boolean).map((g) => loadTMGrammar(g)),
      ),
    );
  }

  if (customGrammars) {
    for (const lang of customGrammars) {
      if (typeof lang === "object" && lang !== null && lang.name && !grammarRegistry.has(lang.name)) {
        grammarRegistry.set(lang.name, lang);
        langs.push(lang as LanguageRegistration);
      }
      if (lang.embeddedLanguages) {
        langs.push(
          ...await Promise.all(
            Object.values(lang.embeddedLanguages)
              .filter((name) => tmGrammars.some((g) => g.name === name))
              .map((name) => loadTMGrammar({ name })),
          ),
        );
      }
    }
  }

  if (typeof theme === "string") {
    if (tmThemes.has(theme) || regHttpURL.test(theme)) {
      themes.push(loadTMTheme(theme));
    }
  } else if (typeof theme === "object" && theme !== null && theme.name) {
    themes.push(theme);
  }

  return getHighlighterCore({ langs, themes, loadWasm });
}

/** Load a TextMate theme from the given source. */
export function loadTMTheme(src: string) {
  if (src === defaultTheme) {
    // @ts-expect-error `DEFAULT_THEME` is defined at build time
    return DEFAULT_THEME;
  }
  const url = tmThemes.has(src) ? `https://esm.sh/tm-themes@${tmThemesVersion}/themes/${src}.json` : src;
  return cache.fetch(url).then((res) => res.json());
}

/** Load a TextMate grammar from the given source. */
export function loadTMGrammar(info: { name?: string; src?: string; embedded?: string[]; injectTo?: string[] }) {
  const url = info.src ?? `https://esm.sh/tm-grammars@${tmGrammarsVersion}/grammars/${info.name}.json`;
  if (info.name && info.embedded) {
    return Promise.all([
      cache.fetch(url).then((res) => res.json()).then((grammar) => ({ injectTo: info.injectTo, ...grammar })),
      ...info.embedded.map((name) => loadTMGrammar({ name })),
    ]);
  }
  return cache.fetch(url).then((res) => res.json());
}

/** Get language ID from file path. */
export function getLanguageIdFromPath(path: string) {
  const idx = path.lastIndexOf(".");
  if (idx > 0) {
    const ext = path.slice(idx + 1);
    const lang = tmGrammars.find((g) => g.name === ext || g.aliases?.includes(ext));
    if (lang) {
      return lang.name;
    }
  }
}

/** Get all grammars in the given VFS. */
export const getGrammarsInVFS = async (vfs: VFS) => {
  const grammars = new Set<string>();
  try {
    const list = await vfs.list();
    for (const path of list) {
      const lang = getLanguageIdFromPath(path);
      if (lang) {
        grammars.add(lang);
      }
    }
  } catch {
    // ignore vfs error
  }
  return grammars;
};

export { tmGrammars, tmThemes };
