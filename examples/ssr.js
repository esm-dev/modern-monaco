import { renderToWebComponent } from "../dist/ssr/index.js";
import { files } from "./shared.js";

export async function ssr(req, filename) {
  return await renderToWebComponent({
    filename: filename,
    code: files[filename],
    padding: { top: 8, bottom: 8 },
    userAgent: req.headers.get("user-agent"),
  });
}
