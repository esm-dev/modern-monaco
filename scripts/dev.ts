const appTsx = `
import confetti from \"https://esm.sh/canvas-confetti@1.6.0\";
import _ from "lodash";
import { useEffect } from \"react\";
import { message } from \"./greeting.ts\";

export default function App() {
  useEffect(() => {
    confetti();
    log(message);
  }, []);
  return (
    <h1>{message}</h1>
  );
}
`.trim();

async function serveDist(url: URL, req: Request) {
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
                text.replace("from \"typescript\"", "from \"https://esm.sh/typescript@5.7.2\""),
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
      "cache-control": "no-cache, no-store, must-revalidate",
      "content-type": getContentType(fileUrl.pathname),
    });
    return new Response(body, { headers });
  } catch (e: any) {
    if (e instanceof Deno.errors.NotFound) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(e.message, { status: 500 });
  }
}

async function servePages(url: URL, req: Request) {
  const { pathname } = url;
  let filename = "index.html";
  if (pathname === "/ssr" || pathname === "/lazy" || pathname === "/manual") {
    filename = pathname.slice(1) + ".html";
  }
  try {
    const fileUrl = new URL("../examples/" + filename, import.meta.url);
    let body = (await Deno.open(fileUrl)).readable;
    if (filename === "ssr.html") {
      let replaced = false;
      const murl = "../dist/ssr/index.js";
      const { renderToWebComponent } = await import(murl);
      const ssrOutput = await renderToWebComponent({
        filename: "src/App.tsx",
        code: appTsx,
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
  } catch (e: any) {
    if (e instanceof Deno.errors.NotFound) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(e.message, { status: 500 });
  }
}

function getContentType(pathname: string) {
  if (pathname.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (pathname.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (pathname.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  return "application/octet-stream";
}

const cmd = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "--no-lock", "scripts/build.ts", "--watch"],
  cwd: new URL("..", import.meta.url).pathname,
});
cmd.spawn();

const workspaceJS = await Deno.readTextFile(new URL("../examples/workspace.js", import.meta.url)).then((text) => {
  return text.replace("$APP_TSX", JSON.stringify(appTsx));
});

Deno.serve(async (req) => {
  let url = new URL(req.url);
  let pathname = url.pathname;
  if (pathname === "/workspace.js") {
    return new Response(
      workspaceJS,
      {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-cache, no-store, must-revalidate",
        },
      },
    );
  }
  if (pathname === "/esm-monaco" || pathname.startsWith("/esm-monaco/")) {
    url = new URL(pathname.slice("/esm-monaco".length) || "/index.js", url);
    return serveDist(url, req);
  }
  return servePages(url, req);
});
