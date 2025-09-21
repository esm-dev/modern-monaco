import { build as esbuild } from "https://deno.land/x/esbuild@v0.25.9/mod.js";
import { grammars as shikiGrammars, injections } from "../node_modules/tm-grammars/index.js";
import { themes as shikiThemes } from "../node_modules/tm-themes/index.js";
import { wasmBinary } from "../node_modules/@shikijs/engine-oniguruma/dist/wasm-inlined.mjs";

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
    outExtension: {
      ".js": ".mjs",
    },
    plugins: [
      {
        name: "external",
        setup(build: any) {
          build.onResolve({ filter: /.*/ }, (args: { path: string; resolveDir: string }) => {
            if (args.path === "typescript" || args.path.endsWith(".wasm")) {
              return {
                path: args.path,
                external: true,
              };
            }
            if (
              args.path.endsWith(".js") && args.path.startsWith(".")
              && args.resolveDir.startsWith(new URL(import.meta.resolve("../src")).pathname)
            ) {
              return {
                path: args.path.replace(".js", ".mjs"),
                external: true,
              };
            }
            return {};
          });
        },
      },
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
    "dist/lsp/typescript/libs.mjs",
    "export default " + JSON.stringify(libs, undefined, 2),
  );
};
const modifyEditorCore = async () => {
  const js = await Deno.readTextFile("dist/editor-core.mjs");
  const ret = await esbuild({
    entryPoints: ["dist/editor-core.css"],
    minify: true,
    write: false,
  });
  const css = ret.outputFiles[0].text;
  const addonCss =
    `.monaco-inputbox input{outline:1px solid var(--vscode-focusBorder)} .rename-box input{color:inherit;font-family:inherit;font-size:100%;}.monaco-editor .rename-box .rename-input-with-button{width:auto}`;
  await Deno.writeTextFile("dist/editor-core.mjs", js + "\nexport const cssBundle = " + JSON.stringify(css + addonCss));
};
const copyDts = (...files: [src: string, dest: string][]) => {
  return Promise.all(files.map(([src, dest]) => Deno.copyFile("node_modules/" + src, "types/" + dest)));
};
const tmDefine = () => {
  const keys = ["name", "scopeName", "aliases", "embedded", "embeddedIn", "injectTo"];

  // add aliases for javascript and typescript
  shikiGrammars.find((g) => g.name === "javascript")!.aliases = ["js", "mjs", "cjs"];
  shikiGrammars.find((g) => g.name === "typescript")!.aliases = ["ts", "mts", "cts"];

  // update embedded grammars
  shikiGrammars.find((g) => g.name === "html")!.embedded = ["json", "css", "javascript"];
  for (const id of ["javascript", "typescript", "jsx", "tsx"]) {
    shikiGrammars.find((v) => v.name === id)!.embedded = ["html", "css"];
  }

  const grammars = shikiGrammars.map((v) => Object.fromEntries(keys.map((k) => [k, v[k as keyof typeof v]])));
  const injections_grammars = injections.map((v) => Object.fromEntries(keys.map((k) => [k, v[k as keyof typeof v]])));

  return {
    SHIKI_THEMES: JSON.stringify(shikiThemes.map((v) => v.name)),
    SHIKI_GRAMMARS: JSON.stringify([...grammars, ...injections_grammars]),
  };
};
const buildEditorCore = async () => {
  await build([
    "src/editor-core.ts",
    "src/editor-worker.ts",
    "src/editor-worker-main.ts",
  ]);
  await modifyEditorCore();
  await Deno.remove("dist/editor-core.css").catch(() => {});
  await Deno.remove("dist/editor-core.css.map").catch(() => {});
};
const buildDist = async () => {
  await build([
    "src/cache.ts",
    "src/index.ts",
    "src/core.ts",
    "src/shiki-wasm.ts",
    "src/util.ts",
    "src/workspace.ts",
    "src/ssr/index.ts",
    "src/ssr/workerd.ts",
    "src/lsp/index.ts",
    "src/lsp/css/setup.ts",
    "src/lsp/css/worker.ts",
    "src/lsp/html/setup.ts",
    "src/lsp/html/worker.ts",
    "src/lsp/json/setup.ts",
    "src/lsp/json/worker.ts",
    "src/lsp/client.ts",
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
      "export type TextmateThemeName = " + shikiThemes.map((v) => JSON.stringify(v.name)).join(" | ") + ";",
      "export type TextmateGrammarName = " + shikiGrammars.map((v) => JSON.stringify(v.name)).join(" | ") + ";",
    ].join("\n"),
  );
};
const debounce = (fn: () => void, ms: number) => {
  let timer: number | null = null;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
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
    const buildDistTask = debounce(() => {
      buildDist().catch(err => console.error(err));
    }, 500);
    const buildEditorCoreTask = debounce(() => {
      buildEditorCore().catch(err => console.error(err));
    }, 500);
    const watcher = Deno.watchFs("src", { recursive: true });
    console.log("Watching for file changes...");
    for await (const event of watcher) {
      const filename = event.paths[0].slice(new URL("src", "file://" + Deno.cwd() + "/").pathname.length + 1);
      if (filename === "editor-core.ts" || filename === "editor-worker.ts") {
        buildEditorCoreTask();
      } else {
        buildDistTask();
      }
    }
  } else {
    Deno.exit(0);
  }
}
