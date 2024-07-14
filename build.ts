import { build as esbuild } from "https://deno.land/x/esbuild@v0.21.5/mod.js";
import { grammars as tmGrammars } from "./node_modules/tm-grammars/index.js";
import { themes as tmThemes } from "./node_modules/tm-themes/index.js";
import { wasmBinary } from "./node_modules/@shikijs/core/dist/wasm-inlined.mjs";

const build = (entryPoints: string[], define?: Record<string, string>) => {
  return esbuild({
    target: "esnext",
    format: "esm",
    platform: "browser",
    outdir: "dist",
    bundle: true,
    treeShaking: true,
    logLevel: "info",
    define,
    loader: {
      ".ttf": "dataurl",
    },
    external: [
      !entryPoints.includes("src/editor-core.ts") ? "*/cache.js" : "",
      "typescript",
      "*/editor-core.js",
      "*/editor-worker.js",
      "*/import-map.js",
      "*/language-features.js",
      "*/libs.js",
      "*/setup.js",
      "*/shiki.js",
      "*/shiki-wasm.js",
      "*/vfs.js",
      "*/util.js",
      "*/worker.js",
      "*/onig.wasm",
    ],
    entryPoints,
  });
};
const bundleTypescriptLibs = async () => {
  const dtsFiles: string[] = [];
  const libDir = "node_modules/typescript/lib";
  const entries = Deno.readDir(libDir);
  for await (const entry of entries) {
    if (entry.name.startsWith("lib.") && entry.name.endsWith(".d.ts")) {
      dtsFiles.push(entry.name);
    }
  }
  dtsFiles.sort();
  const libs = Object.fromEntries(
    await Promise.all(dtsFiles.map(async (name) => {
      return [name, await Deno.readTextFile(libDir + "/" + name)];
    })),
  );
  await Deno.writeTextFile(
    "dist/lsp/typescript/libs.js",
    "export default " + JSON.stringify(libs, undefined, 2),
  );
};
const modifyEditorCore = async () => {
  const js = (await Deno.readTextFile("dist/editor-core.js"))
    // [patch] try to get the `fontMaxDigitWidth` value from the `extraEditorClassName` option
    // the option `fontMaxDigitWidth` uaually is set with SSR mode to keep the line numbers
    // layout consistent with the client side.
    .replace(
      /maxDigitWidth:\s*(\w+)\.fontInfo\.maxDigitWidth/,
      (_, env) => {
        return `maxDigitWidth:globalThis.__monaco_maxDigitWidth||${env}.fontInfo.maxDigitWidth`;
      },
    );
  const ret = await esbuild({
    entryPoints: ["dist/editor-core.css"],
    minify: true,
    write: false,
  });
  // [patch] replace "font-size: 140%" to 100% to fix the size of folding icons
  const css = ret.outputFiles[0].text.replace("font-size:140%", "font-size:100%");
  // [patch] fix the outline color of the input box
  const addonCss = `.monaco-inputbox input{outline: 1px solid var(--vscode-focusBorder,rgba(127, 127, 127, 0.5))}`;
  await Deno.writeTextFile(
    "dist/editor-core.js",
    js + "\nexport const _CSS = " + JSON.stringify(css + addonCss),
  );
};
const copyDts = (...files: [src: string, dest: string][]) => {
  return Promise.all(files.map(([src, dest]) => Deno.copyFile("node_modules/" + src, "types/" + dest)));
};
const tmDefine = () => {
  const keys = ["name", "scopeName", "aliases", "embedded", "embeddedIn", "injectTo"];

  // add aliases for javascript and typescript
  tmGrammars.find((g) => g.name === "javascript")!.aliases = ["js", "mjs", "cjs"];
  tmGrammars.find((g) => g.name === "typescript")!.aliases = ["ts", "mts", "cts"];

  // update embedded grammars
  tmGrammars.find((g) => g.name === "html")!.embedded = ["json", "css", "javascript"];
  for (const id of ["javascript", "typescript", "jsx", "tsx"]) {
    tmGrammars.find((v) => v.name === id)!.embedded = ["html", "css"];
  }

  return {
    TM_THEMES: JSON.stringify(tmThemes.map((v) => v.name)),
    TM_GRAMMARS: JSON.stringify(tmGrammars.map((v) => Object.fromEntries(keys.map((k) => [k, v[k as keyof typeof v]])))),
    VITESSE_DARK: Deno.readTextFileSync("node_modules/tm-themes/themes/vitesse-dark.json"),
  };
};
const buildEditorCore = async () => {
  await build([
    "src/editor-core.ts",
    "src/editor-worker.ts",
  ]);
  await modifyEditorCore();
  await Deno.remove("dist/editor-core.css").catch(() => {});
  await Deno.remove("dist/editor-core.css.map").catch(() => {});
};
const buildDist = async () => {
  await build([
    "src/cache.ts",
    "src/index.ts",
    "src/import-map.ts",
    "src/shiki-wasm.ts",
    "src/util.ts",
    "src/vfs.ts",
    "src/ssr/index.ts",
    "src/ssr/workerd.ts",
    "src/lsp/css/setup.ts",
    "src/lsp/css/worker.ts",
    "src/lsp/html/setup.ts",
    "src/lsp/html/worker.ts",
    "src/lsp/json/setup.ts",
    "src/lsp/json/worker.ts",
    "src/lsp/language-features.ts",
    "src/lsp/typescript/setup.ts",
    "src/lsp/typescript/worker.ts",
  ]);
  await build(["src/shiki.ts"], tmDefine());
};
const buildTypes = async () => {
  await copyDts(
    ["monaco-editor-core/esm/vs/editor/editor.api.d.ts", "monaco.d.ts"],
    ["vscode-json-languageservice/lib/esm/jsonSchema.d.ts", "jsonSchema.d.ts"],
  );
  await Deno.writeTextFile(
    "types/textmate.d.ts",
    [
      "export type TextmateThemeName = " + tmThemes.map((v) => JSON.stringify(v.name)).join(" | ") + ";",
      "export type TextmateGrammarName = " + tmGrammars.map((v) => JSON.stringify(v.name)).join(" | ") + ";",
    ].join("\n"),
  );
};

if (import.meta.main) {
  // clean previous build
  await Deno.remove("dist", { recursive: true }).catch(() => {});

  await buildEditorCore();
  await buildDist();
  await buildTypes();
  await bundleTypescriptLibs();
  await Deno.writeFile("dist/onig.wasm", wasmBinary);

  if (Deno.args.includes("--watch")) {
    const watcher = Deno.watchFs("src", { recursive: true });
    console.log("Watching for file changes...");
    let timer: number | null = null;
    for await (const _event of watcher) {
      timer = timer ?? setTimeout(async () => {
        timer = null;
        try {
          await buildDist();
        } catch (error) {
          console.error(error);
        }
      }, 100);
    }
  } else {
    Deno.exit(0);
  }
}
