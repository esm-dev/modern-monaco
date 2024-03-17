import { build as esbuild } from "esbuild";
import { grammars as tmGrammars } from "tm-grammars";
import { themes as tmThemes } from "tm-themes";

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
      "typescript",
      "*/editor-core.js",
      "*/editor-worker.js",
      "*/import-map.js",
      "*/language-features.js",
      "*/libs.js",
      "*/setup.js",
      "*/worker.js",
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
const modifyEditorJs = async () => {
  const js = (await Deno.readTextFile("dist/editor-core.js"))
    // patch: try to get the `fontMaxDigitWidth` value from the `extraEditorClassName` option
    // the option `fontMaxDigitWidth` uaually is set with SSR mode to keep the line numbers
    // layout consistent with the client side.
    .replace(
      "* maxDigitWidth)",
      "* (Number((options2.get(EditorOptions.extraEditorClassName.id)||'').match(/font-digit-width-([\\d\\_]+)/)?.[1].replace('_','.')) || maxDigitWidth))",
    );
  const ret = await esbuild({
    entryPoints: ["dist/editor-core.css"],
    minify: true,
    write: false,
  });
  // patch: replace "font-size: 140%" to 100% to fix the size of folding icons
  const css = ret.outputFiles[0].text.replace("font-size:140%", "font-size:100%");
  // patch: fix the outline color of the input box
  const addonCss = `.monaco-inputbox input{outline: 1px solid var(--vscode-focusBorder,rgba(127, 127, 127, 0.5))}`;
  await Deno.writeTextFile(
    "dist/editor-core.js",
    "export const _CSS = " + JSON.stringify(css + addonCss) + "\n" + js,
  );
};
const copyDts = (...files: [src: string, dest: string][]) => {
  return Promise.all(files.map(([src, dest]) => Deno.copyFile("node_modules/" + src, "types/" + dest)));
};
const createTmDts = () => {
  return Deno.writeTextFile(
    "types/tm.d.ts",
    [
      "export type TmTheme = " + tmThemes.map((v) => JSON.stringify(v.name)).join(" | ") + ";",
      "export type TmGrammar = " + tmGrammars.map((v) => JSON.stringify(v.name)).join(" | ") + ";",
    ].join("\n"),
  );
};
const tmDefine = () => {
  const grammarKeys = ["name", "scopeName", "aliases", "embedded", "embeddedIn", "injectTo"];

  // add aliases for javascript and typescript
  const javascriptGrammar = tmGrammars.find((g) => g.name === "javascript");
  const typescriptGrammar = tmGrammars.find((g) => g.name === "typescript");
  javascriptGrammar!.aliases!.push("mjs", "cjs", "jsx");
  typescriptGrammar!.aliases!.push("mts", "cts");

  return {
    TM_THEMES: JSON.stringify(tmThemes.map((v) => v.name)),
    TM_GRAMMARS: JSON.stringify(
      tmGrammars.map((v) => Object.fromEntries(grammarKeys.map((k) => [k, v[k as keyof typeof v]]))),
    ),
    VITESSE_DARK: Deno.readTextFileSync("node_modules/tm-themes/themes/vitesse-dark.json"),
  };
};
const buildDist = async () => {
  await Deno.remove("dist", { recursive: true }).catch(() => {});
  await build([
    "src/editor-core.ts",
    "src/editor-worker.ts",
    "src/vfs.ts",
    "src/import-map.ts",
    "src/lsp/language-features.ts",
    "src/lsp/html/setup.ts",
    "src/lsp/html/worker.ts",
    "src/lsp/css/setup.ts",
    "src/lsp/css/worker.ts",
    "src/lsp/json/setup.ts",
    "src/lsp/json/worker.ts",
    "src/lsp/typescript/setup.ts",
    "src/lsp/typescript/worker.ts",
  ]);
  await build(["src/index.ts"], tmDefine());
  await modifyEditorJs();
  await Deno.remove("dist/editor-core.css");
};
const buildTypes = async () => {
  await copyDts(
    ["tm-themes/index.d.ts", "tm-themes.d.ts"],
    ["tm-grammars/index.d.ts", "tm-grammars.d.ts"],
    ["monaco-editor-core/esm/vs/editor/editor.api.d.ts", "monaco.d.ts"],
    ["vscode-json-languageservice/lib/esm/jsonSchema.d.ts", "jsonSchema.d.ts"],
  );
  await createTmDts();
};

await Deno.remove("dist", { recursive: true }).catch(() => {});
await buildDist();
await bundleTypescriptLibs();
await buildTypes();

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
}
