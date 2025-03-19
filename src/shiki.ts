import type { HighlighterCore, LanguageInput, RegexEngine, ThemeInput } from "@shikijs/core";
import { createHighlighterCore } from "@shikijs/core";
import { createOnigurumaEngine, getDefaultWasmLoader, setDefaultWasmLoader } from "@shikijs/engine-oniguruma";
import { version as tmGrammarsVersion } from "../node_modules/tm-grammars/package.json";
import { version as tmThemesVersion } from "../node_modules/tm-themes/package.json";

// ! external modules, don't remove the `.js` extension
import { cache } from "./cache.js";
import { isPlainObject } from "./util.js";

// @ts-expect-error `TM_GRAMMARS` is defined at build time
const tmGrammars: { name: string; aliases?: string[]; embedded?: string[]; injectTo?: string[] }[] = TM_GRAMMARS;
// @ts-expect-error `TM_THEMES` is defined at build time
const tmThemes: Set<string> = new Set(TM_THEMES);

export interface ShikiInitOptions {
  langs?: (string | URL | LanguageInput)[];
  theme?: string | URL | ThemeInput;
  tmDownloadCDN?: string;
  engine?: RegexEngine | Promise<RegexEngine>;
}

export interface Highlighter extends HighlighterCore {
  loadThemeFromCDN(name: string): Promise<void>;
  loadGrammarFromCDN(...ids: string[]): Promise<void>;
}

/** Initialize shiki with the given options. */
export async function initShiki({
  theme = "vitesse-dark",
  langs: languages,
  tmDownloadCDN,
  engine = createOnigurumaEngine(getDefaultWasmLoader()),
}: ShikiInitOptions = {}): Promise<Highlighter> {
  const langs: LanguageInput[] = [];
  const themes: ThemeInput[] = [];

  if (languages?.length) {
    const set = new Set<string>();
    languages.forEach((l) => {
      if (typeof l === "string" || l instanceof URL) {
        if (!set.has(l.toString())) {
          const g = tmGrammars.find((g) => g.name === l);
          if (g?.embedded) {
            langs.push(...g.embedded.map((id) => loadTMGrammar(id, tmDownloadCDN)));
          }
          langs.push(loadTMGrammar(l, tmDownloadCDN));
          set.add(l.toString());
        }
      } else if (isPlainObject(l)) {
        langs.push(l);
      }
    });
  }

  if (typeof theme === "string" || theme instanceof URL) {
    themes.push(await loadTMTheme(theme, tmDownloadCDN));
  } else if (isPlainObject(theme)) {
    themes.push(theme);
  }

  const highlighterCore = await createHighlighterCore({ langs, themes, engine });
  Object.assign(highlighterCore, {
    loadThemeFromCDN: (themeName: string) => highlighterCore.loadTheme(loadTMTheme(themeName, tmDownloadCDN)),
    loadGrammarFromCDN: (...ids: string[]) => highlighterCore.loadLanguage(...ids.map(id => loadTMGrammar(id, tmDownloadCDN))),
  });
  return highlighterCore as unknown as Highlighter;
}

/** Load a TextMate theme from the given source. */
function loadTMTheme(src: string | URL, cdn = "https://esm.sh") {
  if (src === "vitesse-dark") {
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
    if (g) {
      const url = new URL(`/tm-grammars@${tmGrammarsVersion}/grammars/${g.name}.json`, cdn);
      return cache.fetch(url).then((res) => res.json());
    }
    return cache.fetch(src).then((res) => res.json());
  }
  return cache.fetch(src).then((res) => res.json());
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
    return tmGrammars.find((g) => g.name === ext || g.aliases?.includes(ext));
  }
}

/** Get language ID from the given path. */
export function getLanguageIdFromPath(path: string): string | undefined {
  return getGarmmarInfoFromPath(path)?.name;
}

export * from "./render.ts";
export * from "./shiki-monaco.ts";
export { setDefaultWasmLoader, tmGrammars, tmThemes };
