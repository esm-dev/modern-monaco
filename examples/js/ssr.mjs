import { renderToWebComponent } from "../../dist/ssr/index.mjs";
import { files } from "./files.mjs";

const filename = "src/App.tsx";

export default {
  async fetch(req) {
    const ssrOutput =  await renderToWebComponent(
      { filename, code: files[filename] },
      {
        padding: { top: 8, bottom: 8 },
        userAgent: req.headers.get("user-agent"),
      }
    );
    const html = await Deno.readTextFile(new URL("../ssr.html", import.meta.url));
    return new Response(html.replace("{SSR}", ssrOutput), {
      headers: {
        "cache-control": "public, max-age=0, revalidate",
        "content-type": "text/html; charset=utf-8",
      },
    });
  }
}
