import type { ThemeInput } from "@shikijs/core";
import type { LanguageInput } from "@shikijs/core";
import type { VFS } from "./vfs";
import loadWasm from "@shikijs/core/wasm-inlined";
import { getHighlighterCore } from "@shikijs/core";
import { version as tmGrammarsVersion } from "../node_modules/tm-grammars/package.json";
import { version as tmThemesVersion } from "../node_modules/tm-themes/package.json";
import { cache } from "./cache.js";

// @ts-expect-error `TM_GRAMMARS` is defined at build time
const tmGrammars: { name: string; aliases?: string[]; embedded?: string[]; injectTo?: string[] }[] = TM_GRAMMARS;
// @ts-expect-error `TM_THEMES` is defined at build time
const tmThemes: Set<string> = new Set(TM_THEMES);

const vitesseDark = "vitesse-dark";

export interface ShikiInitOptions {
  theme?: string | URL | ThemeInput;
  langs?: (LanguageInput | string | URL)[];
}

/** Initialize shiki with the given options. */
export async function initShiki({
  theme = vitesseDark,
  langs: languages,
}: ShikiInitOptions) {
  const langs: LanguageInput[] = [];
  const themes: ThemeInput[] = [];

  if (languages?.length > 0) {
    languages.forEach((input) => {
      if (typeof input === "string" || input instanceof URL) {
        const g = tmGrammars.find((g) => g.name === input);
        if (g?.embedded) {
          langs.push(...g.embedded.map((id) => loadTMGrammar(id)));
        }
        langs.push(loadTMGrammar(input));
      } else {
        langs.push(input);
        if ((input as any).embeddedLanguages) {
          langs.push(...Object.values((input as any).embeddedLanguages).map((id: string) => loadTMGrammar(id)));
        }
      }
    });
  }

  if (typeof theme === "string" || theme instanceof URL) {
    themes.push(loadTMTheme(theme));
  } else if (typeof theme === "object" && theme !== null) {
    themes.push(theme);
  }

  return getHighlighterCore({ langs, themes, loadWasm });
}

/** Load a TextMate theme from the given source. */
export function loadTMTheme(src: string | URL) {
  if (src === vitesseDark) {
    // @ts-expect-error `VITESSE_DARK` is defined at build time
    return VITESSE_DARK;
  }
  const isThemeName = typeof src === "string" && tmThemes.has(src);
  const url = isThemeName ? `https://esm.sh/tm-themes@${tmThemesVersion}/themes/${src}.json` : src;
  return cache.fetch(url).then((res) => res.json());
}

/** Load a TextMate grammar from the given source. */
export function loadTMGrammar(src: string | URL) {
  const g = tmGrammars.find(g => g.name === src);
  if (g) {
    const url = `https://esm.sh/tm-grammars@${tmGrammarsVersion}/grammars/${g.name}.json`;
    return cache.fetch(url).then((res) => res.json()).then((grammar) => ({
      injectTo: g.injectTo,
      ...grammar,
    }));
  }
  return cache.fetch(src).then((res) => res.json());
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

/** Get all grammar IDs in the given VFS. */
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
  return Array.from(grammars);
};

export { tmGrammars, tmThemes };
