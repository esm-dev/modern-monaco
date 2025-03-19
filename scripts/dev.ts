async function serveDist(url: URL, req: Request) {
  try {
    const fileUrl = new URL("../dist" + url.pathname, import.meta.url);
    let body = (await Deno.open(fileUrl)).readable;
    if (url.pathname === "/lsp/typescript/worker.js") {
      let replaced = false;
      body = body.pipeThrough(
        new TransformStream<Uint8Array>({
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
  if (pathname === "/ssr" || pathname === "/lazy" || pathname === "/manual" || pathname === "/compare") {
    filename = pathname.slice(1) + ".html";
  }
  try {
    const fileUrl = new URL("../examples/" + filename, import.meta.url);
    if (filename === "ssr.html") {
      const { default: ssr } = await import("../examples/js/ssr.js");
      return ssr.fetch(req);
    }
    const headers = new Headers({
      "transfer-encoding": "chunked",
      "cache-control": "public, max-age=0, revalidate",
      "content-type": getContentType(fileUrl.pathname),
    });
    return new Response((await Deno.open(fileUrl)).readable, { headers });
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

Deno.serve(async (req) => {
  let url = new URL(req.url);
  let pathname = url.pathname;
  if (pathname.startsWith("/js/")) {
    const file = await Deno.open(new URL("../examples" + pathname, import.meta.url));
    return new Response(
      file.readable,
      {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-cache, no-store, must-revalidate",
        },
      },
    );
  }
  if (pathname === "/modern-monaco" || pathname.startsWith("/modern-monaco/")) {
    url = new URL(pathname.slice("/modern-monaco".length) || "/index.js", url);
    return serveDist(url, req);
  }
  return servePages(url, req);
});
