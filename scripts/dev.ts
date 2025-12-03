import { build } from "./build";

async function serveDist(url: URL, req: Request) {
  try {
    const fileUrl = new URL("../dist" + url.pathname, import.meta.url);
    const file = Bun.file(fileUrl);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    let body = file.stream();
    if (url.pathname === "/lsp/typescript/worker.mjs") {
      let replaced = false;
      body = body.pipeThrough(
        new TransformStream<Uint8Array>({
          transform: (chunk, controller) => {
            if (replaced) {
              controller.enqueue(chunk);
              return;
            }
            const text = new TextDecoder().decode(chunk);
            if (text.includes('from "typescript"')) {
              controller.enqueue(new TextEncoder().encode(
                text.replace('from "typescript"', 'from "https://esm.sh/typescript@5.9.3"'),
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
    return new Response(e.message, { status: 500 });
  }
}

async function servePages(url: URL, req: Request) {
  const { pathname } = url;
  let filename = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!filename.endsWith(".html")) {
    filename += ".html";
  }
  try {
    const fileUrl = new URL("../examples/" + filename, import.meta.url);
    const file = Bun.file(fileUrl);
    if (!(await file.exists())) {
      if (filename !== "index.html") {
        return servePages(new URL("/", url), req);
      }
      return new Response("Not found", { status: 404 });
    }
    if (filename === "ssr.html") {
      const { default: ssr } = await import("../examples/js/ssr.mjs");
      return ssr.fetch(req);
    }
    const headers = new Headers({
      "transfer-encoding": "chunked",
      "cache-control": "public, max-age=0, revalidate",
      "content-type": getContentType(fileUrl.pathname),
    });
    return new Response(file.stream(), { headers });
  } catch (e: any) {
    return new Response(e.message, { status: 500 });
  }
}

function getContentType(pathname: string) {
  if (pathname.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (pathname.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) {
    return "application/javascript; charset=utf-8";
  }
  if (pathname.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  return "application/octet-stream";
}

const server = Bun.serve({
  port: 8000,
  fetch: async (req) => {
    let url = new URL(req.url);
    let pathname = url.pathname;

    if (pathname.startsWith("/json/") || pathname.startsWith("/js/")) {
      const file = Bun.file(new URL("../examples" + pathname, import.meta.url));
      return new Response(
        file.stream(),
        {
          headers: {
            "content-type": getContentType(pathname),
            "cache-control": "no-cache, no-store, must-revalidate",
          },
        },
      );
    }

    if (pathname === "/modern-monaco" || pathname.startsWith("/modern-monaco/")) {
      url = new URL(pathname.slice("/modern-monaco".length) || "/index.js", url);
      return serveDist(url, req);
    }

    if (pathname.endsWith("/favicon.ico") || pathname.startsWith("/.well-known/")) {
      return new Response("Not found", { status: 404 });
    }

    return servePages(url, req);
  },
});

await build(true);

console.log(`
Server is running on ${server.url}
Examples:
  General - ${server.url}
  Lazy mode - ${server.url}lazy
  Manual mode - ${server.url}manual
  Manual mode (without workspace) - ${server.url}manual-no-workspace
  Custom theme(json) - ${server.url}custom-theme
  SSR mode - ${server.url}ssr
  Compare modes - ${server.url}compare
`);
