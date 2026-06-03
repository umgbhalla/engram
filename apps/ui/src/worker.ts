// engram-ui Worker — serves the notebook SPA. Static, no bindings; the page connects
// directly over WebSocket to the live codemode kernel. A tiny /healthz for smoke checks.
import INDEX_HTML from "./index.html";

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true, app: "engram-ui" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(INDEX_HTML, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
