const importMap = {
  imports: {
    "@jsxImportSource": "https://esm.sh/react@18.2.0",
    "react": "https://esm.sh/react@18.2.0",
    "react-dom/": "https://esm.sh/react-dom@18.2.0/",
  },
};
const files = {
  "log.d.ts": [
    "/** log a message. */",
    "declare function log(message:string): void;",
  ],
  "greeting.ts": [
    "export const message = \"Hello world!\" as const;",
  ],
  "index.html": [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <title>React App</title>",
    "  <link rel=\"stylesheet\" href=\"./style.css\">",
    "  \<script type=\"importmap\">",
    JSON.stringify(importMap, null, 2).split("\n").map((line) => "  " + line).join("\n"),
    "  <\/script>",
    "</head>",
    "<body>",
    "  <div id=\"root\"></div>",
    "  <script type=\"module\" src=\"./main.jsx\"><\/script>",
    "</body>",
    "</html>",
  ],
  "style.css": [
    "h1 {",
    "  font-style: italic;",
    "}",
  ],
  "App.tsx": [
    "import confetti from \"https://esm.sh/canvas-confetti@1.6.0\"",
    "import { useEffect } from \"react\"",
    "import { message } from \"./greeting.ts\"",
    "",
    "export default function App() {",
    "  useEffect(() => {",
    "    confetti()",
    "    log(message)",
    "  }, [])",
    "  return <h1>{message}</h1>;",
    "}",
  ],
  "main.jsx": [
    "import { createRoot } from \"react-dom/client\"",
    "import App from \"./App.tsx\"",
    "",
    "const root = createRoot(document.getElementById(\"root\"))",
    "root.render(<App />)",
  ],
  "import_map.json": JSON.stringify(importMap, null, 2),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        types: [
          "log.d.ts",
          "https://raw.githubusercontent.com/vitejs/vite/main/packages/vite/types/importMeta.d.ts",
        ],
      },
    },
    null,
    2,
  ),
};

async function serveDist(url: URL, req: Request, notFound: (url: URL, req: Request) => Promise<Response>) {
  if (url.pathname === "/") {
    return notFound(url, req);
  }
  if (url.pathname.endsWith("/")) {
    return new Response("Directory listing not supported", {
      status: 400,
    });
  }
  try {
    const fileUrl = new URL("../dist" + url.pathname, import.meta.url);
    let body = (await Deno.open(fileUrl)).readable;
    if (url.pathname === "/lsp/typescript/worker.js") {
      let replaced = false;
      body = body.pipeThrough(
        new TransformStream({
          transform: (chunk, controller) => {
            if (replaced) {
              controller.enqueue(chunk);
              return;
            }
            const text = new TextDecoder().decode(chunk);
            if (text.includes("from \"typescript\"")) {
              controller.enqueue(new TextEncoder().encode(
                text.replace(
                  "from \"typescript\"",
                  "from \"https://esm.sh/typescript@5.4.2\"",
                ),
              ));
              replaced = true;
            } else {
              controller.enqueue(chunk);
            }
          },
        }),
      );
    }
    const headers = new Headers({
      "transfer-encoding": "chunked",
      "cache-control": "public, max-age=0, revalidate",
      "content-type": getContentType(fileUrl.pathname),
    });
    return new Response(body, { headers });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return notFound(url, req);
    }
    return new Response(e.message, {
      status: 500,
    });
  }
}

async function servePages(url: URL, req: Request) {
  const filename = url.pathname.slice(1) || "index.html";
  try {
    const fileUrl = new URL(filename, import.meta.url);
    let body = (await Deno.open(fileUrl)).readable;
    if (filename === "ssr.html") {
      let replaced = false;
      const murl = "./dist/index.js";
      const { renderToWebComponent } = await import(murl);
      const ssrOutput = await renderToWebComponent({
        filename: "App.tsx",
        code: files["App.tsx"].join("\n"),
        padding: { top: 8, bottom: 8 },
        userAgent: req.headers.get("user-agent"),
      });
      body = body.pipeThrough(
        new TransformStream({
          transform: (chunk, controller) => {
            if (replaced) {
              controller.enqueue(chunk);
              return;
            }
            const text = new TextDecoder().decode(chunk);
            const searchExpr = /\{SSR}/;
            const m = text.match(searchExpr);
            if (m) {
              controller.enqueue(new TextEncoder().encode(
                text.replace(searchExpr, ssrOutput),
              ));
              replaced = true;
            } else {
              controller.enqueue(chunk);
            }
          },
        }),
      );
    }
    const headers = new Headers({
      "transfer-encoding": "chunked",
      "cache-control": "public, max-age=0, revalidate",
      "content-type": getContentType(fileUrl.pathname),
    });
    return new Response(body, { headers });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return new Response("Not found", {
        status: 404,
      });
    }
    return new Response(e.message, {
      status: 500,
    });
  }
}

function getContentType(pathname: string) {
  if (pathname.endsWith(".css")) {
    return "text/css; utf-8";
  }
  if (pathname.endsWith(".js")) {
    return "application/javascript; utf-8";
  }
  if (pathname.endsWith(".html")) {
    return "text/html; utf-8";
  }
  return "application/octet-stream";
}

const cmd = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "build.ts", "--watch"],
  cwd: new URL("..", import.meta.url).pathname,
});
cmd.spawn();

Deno.serve((req) => {
  let url = new URL(req.url);
  if (url.pathname.startsWith("/dist/")) {
    url = new URL(url.pathname.slice(5), url);
  }
  if (url.pathname === "/init.js") {
    const headers = new Headers({
      "cache-control": "public, max-age=0, revalidate",
      "content-type": getContentType(url.pathname),
    });
    return new Response(
      `import { VFS } from "/vfs.js";export const vfs = new VFS({ scope: "test", initial: ${
        JSON.stringify(files, null, 2)
      } });`,
      { headers },
    );
  }
  return serveDist(url, req, servePages);
});
