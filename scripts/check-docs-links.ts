/**
 * Fails the build on a broken internal link in the generated help site.
 *
 * Cross-page anchors are the thing worth guarding: renaming a heading
 * silently breaks every `page.md#old-anchor` pointing at it, and nothing
 * else in the pipeline would notice. External URLs are deliberately NOT
 * fetched — that would make the docs build depend on the whole internet
 * being up.
 *
 * Run after `docs:build`; reads site/ and exits non-zero with a report.
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const OUT = new URL("../site", import.meta.url).pathname;

if (!existsSync(OUT)) {
  console.error("site/ does not exist — run `bun run docs:build` first");
  process.exit(1);
}

const files = (await readdir(OUT)).filter((f) => f.endsWith(".html"));
const pages = new Map<string, string>();
for (const f of files) pages.set(f, await readFile(join(OUT, f), "utf8"));

const idsOf = new Map<string, Set<string>>();
for (const [name, html] of pages) {
  idsOf.set(name, new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!)));
}

const problems: string[] = [];

for (const [name, html] of pages) {
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1]!;
    if (/^(https?:|mailto:|#$)/.test(href)) continue;

    const [rawTarget, frag] = href.split("#") as [string, string | undefined];

    // Same-page anchor.
    if (rawTarget === "") {
      if (frag && !idsOf.get(name)!.has(frag)) problems.push(`${name} → #${frag} (no such anchor on this page)`);
      continue;
    }

    // DOCS_BASE-prefixed paths resolve to the artifact root either way.
    const target = rawTarget.replace(/^\/sleipnir\//, "").replace(/^\//, "");

    if (/\.(css|js|png|jpe?g|svg|json|ico)$/.test(target)) {
      if (!existsSync(join(OUT, target))) problems.push(`${name} → ${target} (missing asset)`);
      continue;
    }

    if (!pages.has(target)) {
      problems.push(`${name} → ${target} (missing page)`);
    } else if (frag && !idsOf.get(target)!.has(frag)) {
      problems.push(`${name} → ${target}#${frag} (no such anchor on target page)`);
    }
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} broken link(s):`);
  for (const p of [...new Set(problems)].sort()) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`internal links OK across ${pages.size} pages`);
