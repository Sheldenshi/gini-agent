// Minimal static server for the provider-docs slide deck, bound to 0.0.0.0 so
// it's reachable from other devices on the LAN. Serves only files under deck/
// (path-traversal guarded). Run: bun scripts/serve-deck.ts
import { file } from "bun";
import { join, normalize, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "deck");
const PORT = Number(process.env.DECK_PORT ?? 8651);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    // Resolve under ROOT and reject anything that escapes it. The boundary must
    // be ROOT itself OR a path under ROOT + separator — a bare startsWith(ROOT)
    // would also admit a sibling whose name merely begins with "deck"
    // (e.g. deck-private/). decodeURIComponent runs first, so encoded "%2e%2e"
    // traversals are normalized here too.
    const abs = normalize(join(ROOT, rel));
    if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return new Response("Forbidden", { status: 403 });
    const f = file(abs);
    if (!(await f.exists())) return new Response("Not found", { status: 404 });
    const ext = abs.slice(abs.lastIndexOf("."));
    return new Response(f, { headers: { "content-type": TYPES[ext] ?? "application/octet-stream" } });
  }
});

// Print every bound address so the LAN URL is easy to grab.
const nets = Object.values(require("node:os").networkInterfaces()).flat();
const lan = nets.filter((n: any) => n && n.family === "IPv4" && !n.internal).map((n: any) => n.address);
console.log(`Deck serving on 0.0.0.0:${server.port}`);
console.log(`  local:   http://127.0.0.1:${server.port}/`);
for (const ip of lan) console.log(`  network: http://${ip}:${server.port}/`);
