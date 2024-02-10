import { build as esbuild } from "https://deno.land/x/esbuild@v0.20.0/mod.js";
import { grammars as tmGrammars } from "tm-grammars";
import { themes as tmThemes } from "tm-themes";

// add aliases for javascript and typescript
const javascriptGrammar = tmGrammars.find((g) => g.name === "javascript");
const typescriptGrammar = tmGrammars.find((g) => g.name === "typescript");
javascriptGrammar!.aliases!.push("mjs", "cjs", "jsx");
typescriptGrammar!.aliases!.push("mts", "cts", "tsx");

const tmDefine = {
  "TM_THEMES": JSON.stringify(tmThemes.map((v) => v.name)),
  "TM_GRAMMARS": JSON.stringify(tmGrammars.map((v) => ({ name: v.name, aliases: v.aliases }))),
};
const build = (entryPoints: string[], define?: Record<string, string>) => {
  return esbuild({
    target: "esnext",
    format: "esm",
    platform: "browser",
    outdir: "dist",
    bundle: true,
    logLevel: "info",
    define,
    loader: {
      ".ttf": "dataurl",
    },
    external: [
      "typescript",
      "*/libs.js",
      "*/worker.js",
      "*/editor-core.js",
      "*/editor-worker.js",
      "*/language-features.js",
      "*/setup.js",
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
  const css = await Deno.readTextFile("dist/editor-core.css");
  const js = (await Deno.readTextFile("dist/editor-core.js"))
    // patch: try to get the `fontMaxDigitWidth` value from the `extraEditorClassName` option
    // the option `fontMaxDigitWidth` uaually is set with SSR mode to keep the line numbers
    // layout consistent with the client side.
    .replace(
      "* maxDigitWidth)",
      "* (Number(options2.get(140).match(/font-max-digit-width-([\\d\\_]+)/)?.[1].replace('_','.')) || maxDigitWidth))",
    );
  await Deno.writeTextFile(
    "dist/editor-core.js",
    "export const _CSS = " + JSON.stringify(css) + "\n" + js,
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
const buildDist = async () => {
  await build([
    "src/editor-core.ts",
    "src/editor-worker.ts",
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
  await build(["src/index.ts"], tmDefine);
  await modifyEditorJs();
};
const buildTypes = async () => {
  await copyDts(
    ["tm-themes/index.d.ts", "tm-themes.d.ts"],
    ["tm-grammars/index.d.ts", "tm-grammars.d.ts"],
    ["monaco-editor-core/esm/vs/editor/editor.api.d.ts", "monaco.d.ts"],
  );
  await createTmDts();
};
const debounce = <T extends (...args: unknown[]) => unknown>(fn: T, ms: number) => {
  let timeout: number;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  };
};

await bundleTypescriptLibs();
await buildTypes();
await buildDist();

if (Deno.args.includes("--watch")) {
  const rebuildDist = debounce(buildDist, 500);
  const watcher = Deno.watchFs("src", { recursive: true });
  console.log("Watching for file changes...");
  for await (const _event of watcher) {
    rebuildDist();
  }
}
