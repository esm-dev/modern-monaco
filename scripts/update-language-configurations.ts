console.log("Checking the latest version of vscode...");
const html = await fetch("https://github.com/microsoft/vscode/tags").then((res) => res.text());
const tags = new Set([...html.matchAll(/\/microsoft\/vscode\/releases\/tag\/(\d+\.\d+\.\d+)/g)].map((m) => m[1]));
const latest = [...tags].sort((a, b) => {
  const [a1, a2, a3] = a.split(".").map(Number);
  const [b1, b2, b3] = b.split(".").map(Number);
  return a1 - b1 || a2 - b2 || a3 - b3;
}).pop();

if (prompt(`The latest version of vscode is ${latest}. Do you want to update to this version? (y/N)`) !== "y") {
  process.exit(0);
}

// download vscode repository
console.log("Downloading vscode repository...");
const res = await fetch(
  "https://codeload.github.com/microsoft/vscode/tar.gz/refs/tags/" + latest,
);
await Bun.write("node_modules/vscode.tar.gz", await res.blob());

// extract vscode repository to a folder
try {
  await Bun.$`mkdir -p node_modules/vscode`;
  await Bun.$`tar -xzf node_modules/vscode.tar.gz -C node_modules/vscode --strip-components=1`;
} finally {
  await Bun.$`rm -f node_modules/vscode.tar.gz`;
}

try {
  const promises: Promise<[string, object]>[] = [];
  const configurations: [lang: string, configFile: string][] = [];
  const glob = new Bun.Glob("node_modules/vscode/extensions/**/*language-configuration.json");
  for await (const entry of glob.scanSync()) {
    const lang = /\/extensions\/([^/]+)\//.exec(entry)?.[1]?.replace(/-basics$/, "");
    if (!lang) {
      continue;
    }
    if (
      entry.endsWith("/language-configuration.json")
      || entry.endsWith("/" + lang + "-language-configuration.json")
      || entry.endsWith("/" + lang + ".language-configuration.json")
    ) {
      await Bun.$`mv ${entry} ${entry}c`; // rename to jsonc
      console.log(`[${lang}]`, entry, "found");
      configurations.push([lang, entry]);
      promises.push(import("../" + entry + "c").then(config => [lang, config]));
    }
  }
  configurations.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [lang, configFile] of configurations) {
    console.log(`[${lang}]`, configFile, "found");
    promises.push(import("../" + configFile + "c").then(config => [lang, config]));
  }
  await Bun.write("language-configurations.json", JSON.stringify(Object.fromEntries(await Promise.all(promises)), undefined, 2));
  console.log(`✨ Done! ${configurations.length} language configuration files are updated.`);
} finally {
  await Bun.$`rm -rf node_modules/vscode`;
}
