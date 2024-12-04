import { parse } from "jsr:@std/jsonc";

console.log("Checking the latest version of vscode...");
const html = await fetch("https://github.com/microsoft/vscode/tags").then((res) => res.text());
const tags = new Set([...html.matchAll(/\/microsoft\/vscode\/releases\/tag\/(\d+\.\d+\.\d+)/g)].map((m) => m[1]));
const latest = [...tags].sort((a, b) => {
  const [a1, a2, a3] = a.split(".").map(Number);
  const [b1, b2, b3] = b.split(".").map(Number);
  return a1 - b1 || a2 - b2 || a3 - b3;
}).pop();

if (prompt(`The latest version of vscode is ${latest}. Do you want to update to this version? (y/N)`) !== "y") {
  Deno.exit(0);
}

const tmpDir = await Deno.makeTempDir();

// download vscode repository
console.log("Downloading vscode repository...");
const res = await fetch(
  "https://codeload.github.com/microsoft/vscode/tar.gz/refs/tags/" + latest,
);
const fd = await Deno.open(tmpDir + "/vscode.tar.gz", {
  write: true,
  create: true,
  truncate: true,
});
await res.body?.pipeTo(fd.writable);

// extract vscode repository to a folder
try {
  const cmd = new Deno.Command("tar", {
    args: ["-xzf", "vscode.tar.gz", "--strip-components=1"],
    stdout: "piped",
    stderr: "piped",
    cwd: tmpDir,
  });
  const { success } = await cmd.spawn().status;
  if (!success) {
    Deno.exit(1);
  }
} catch {
  await Deno.remove(tmpDir, { recursive: true });
}

try {
  const promises: Promise<[string, object]>[] = [];
  await readDir(tmpDir + "/extensions", (entry) => {
    const segs = entry.split("/");
    const extName = segs[segs.length - 2].replace("-basics", "");
    promises.push(Deno.readTextFile(entry).then(text => [extName, parse(text) as object]));
  });
  const filename = new URL("../language-configurations.json", import.meta.url).pathname;
  await Deno.writeTextFile(filename, JSON.stringify(Object.fromEntries(await Promise.all(promises)), undefined, 2));
  console.log(`Done! ${promises.length} language configuration files are updated.`);
} finally {
  await Deno.remove(tmpDir, { recursive: true });
}

async function readDir(root: string, callback: (entry: string) => void) {
  for await (const entry of Deno.readDir(root)) {
    if (entry.isDirectory) {
      await readDir(root + "/" + entry.name, callback);
    } else if (entry.name === "language-configuration.json" || entry.name === root.split("/").pop() + "-language-configuration.json") {
      callback(root + "/" + entry.name);
    }
  }
}
