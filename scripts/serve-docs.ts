/**
 * Local preview for the built help site. `bun run docs:serve` builds into
 * site/ and serves it at the root, which is how DOCS_BASE-less builds are
 * laid out; the deployed Pages build sets DOCS_BASE=/sleipnir instead.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const OUT = new URL("../site", import.meta.url).pathname;
// 4321 is Astro's default and often already taken; bind explicitly to
// loopback so a server on another interface can never shadow this one.
const PORT = Number(process.env.PORT ?? 4318);
const HOSTNAME = process.env.HOST ?? "127.0.0.1";

if (!existsSync(OUT)) {
  console.error("site/ does not exist — run `bun run docs:build` first");
  process.exit(1);
}

Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    // Bare /getting-started resolves to the built page, so links copied
    // from the deployed site work here too.
    if (!path.includes(".")) path += ".html";

    // Keep traversal inside site/ — this is a dev server, but an escaping
    // path would happily read the rest of the disk.
    const file = Bun.file(join(OUT, path));
    if (!join(OUT, path).startsWith(OUT) || !(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(file);
  },
});

console.log(`help site → http://${HOSTNAME}:${PORT}`);
