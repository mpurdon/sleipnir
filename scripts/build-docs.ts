/**
 * Builds the help site in docs-src/ into site/ — plain static HTML, no
 * client framework, deployed to GitHub Pages by .github/workflows/pages.yml.
 *
 * Every page is Markdown with a small YAML-ish front matter block:
 *
 *   ---
 *   title: Projects
 *   order: 40
 *   summary: Bundle services and engage them as one.
 *   ---
 *
 * `order` drives the sidebar sequence and the prev/next footer links, so
 * inserting a page between two others only means picking a number between
 * theirs. Run with `bun run docs:build`; `bun run docs:serve` previews it.
 */
import { marked } from "marked";
import { mkdir, readdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "docs-src");
const OUT = join(ROOT, "site");
const SCREENSHOTS = join(ROOT, "docs");
const APP_ASSETS = join(ROOT, "src", "assets");

/** Set by the Pages workflow so links and asset paths resolve under the
 * /sleipnir/ project-site prefix; empty for local previews at the root. */
const BASE = (process.env.DOCS_BASE ?? "").replace(/\/$/, "");

type Page = {
  slug: string;
  title: string;
  order: number;
  summary: string;
  /** Rendered HTML body. */
  html: string;
  /** Section headings, for the in-page table of contents and search. */
  headings: { id: string; text: string; level: number }[];
  /** Plain text, for the search index. */
  text: string;
};

/**
 * Minimal front matter parser — the docs only ever use flat `key: value`
 * string pairs, so a YAML dependency would be dead weight. Values may be
 * quoted; anything after the closing `---` is the Markdown body.
 */
function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: raw };
  const block = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const meta: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    meta[m[1]!] = m[2]!.trim().replace(/^["'](.*)["']$/, "$1");
  }
  return { meta, body };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Renders one Markdown body, collecting headings on the way so the page
 * can carry a table of contents and feed the search index.
 */
function render(body: string): Pick<Page, "html" | "headings" | "text"> {
  const headings: Page["headings"] = [];
  const seen = new Map<string, number>();

  const renderer = new marked.Renderer();
  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const plain = text.replace(/<[^>]+>/g, "");
    let id = slugify(plain);
    // Duplicate headings across a long page would otherwise collide and
    // send every matching anchor to the first one.
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    if (depth >= 2 && depth <= 3) headings.push({ id, text: plain, level: depth });
    return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${text}</h${depth}>\n`;
  };

  // Screenshots live in docs/ (the README uses them too) and are copied
  // into the site build; rewrite the repo-relative paths accordingly.
  renderer.image = function ({ href, title, text }) {
    const src = href.startsWith("docs/") ? `${BASE}/screenshots/${basename(href)}` : href;
    const t = title ? ` title="${escapeHtml(title)}"` : "";
    return `<figure><img src="${src}" alt="${escapeHtml(text)}"${t} loading="lazy" /><figcaption>${escapeHtml(text)}</figcaption></figure>`;
  };

  // Internal .md links become .html; external links open in a new tab.
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const t = title ? ` title="${escapeHtml(title)}"` : "";
    if (/^https?:/.test(href)) return `<a href="${href}"${t} target="_blank" rel="noopener">${text}</a>`;
    const fixed = href.replace(/\.md(#|$)/, ".html$1");
    const prefixed = fixed.startsWith("#") ? fixed : `${BASE}/${fixed.replace(/^\//, "")}`;
    return `<a href="${prefixed}"${t}>${text}</a>`;
  };

  // GitHub-style alerts: `> [!NOTE]` and friends become styled callouts.
  const ALERTS: Record<string, { cls: string; label: string }> = {
    NOTE: { cls: "note", label: "Note" },
    TIP: { cls: "tip", label: "Tip" },
    IMPORTANT: { cls: "note", label: "Important" },
    WARNING: { cls: "warning", label: "Warning" },
    CAUTION: { cls: "warning", label: "Caution" },
    DANGER: { cls: "danger", label: "Danger" },
  };
  renderer.blockquote = function ({ tokens }) {
    const inner = this.parser.parse(tokens);
    const m = /^\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|DANGER)\]\s*/i.exec(inner);
    if (!m) return `<blockquote>\n${inner}</blockquote>\n`;
    const { cls, label } = ALERTS[m[1]!.toUpperCase()]!;
    const rest = inner.slice(m[0].length);
    return `<div class="alert alert-${cls}"><span class="alert-label">${label}</span>\n<p>${rest}</div>\n`;
  };

  let html = marked.parse(body, { renderer, async: false }) as string;
  // Wide tables scroll inside their own box rather than the page. Done here
  // as well as in search.js so it holds with JavaScript disabled.
  html = html.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, "</table></div>");
  // Plain text for the search index and snippets. Order matters: fenced
  // code and raw HTML go first (index.md embeds a card list as HTML, whose
  // tags would otherwise surface inside search snippets), then link text is
  // unwrapped, then the remaining Markdown punctuation is dropped.
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION|DANGER)\]/gi, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^---[\s\S]*?---/g, " ")
    .replace(/[#*_`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { html, headings, text };
}

function layout(page: Page, pages: Page[]): string {
  const idx = pages.findIndex((p) => p.slug === page.slug);
  const prev = idx > 0 ? pages[idx - 1] : null;
  const next = idx < pages.length - 1 ? pages[idx + 1] : null;
  const home = `${BASE}/index.html`;

  const nav = pages
    .map(
      (p) =>
        `<li><a href="${BASE}/${p.slug}.html"${p.slug === page.slug ? ' class="current" aria-current="page"' : ""}>${escapeHtml(p.title)}</a></li>`,
    )
    .join("\n          ");

  const toc = page.headings.length
    ? `<nav class="toc" aria-label="On this page">
          <p class="toc-head">On this page</p>
          <ul>
            ${page.headings.map((h) => `<li class="toc-l${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join("\n            ")}
          </ul>
        </nav>`
    : "";

  const pager = `<nav class="pager">
        ${prev ? `<a class="pager-prev" href="${BASE}/${prev.slug}.html"><span>Previous</span><strong>${escapeHtml(prev.title)}</strong></a>` : "<span></span>"}
        ${next ? `<a class="pager-next" href="${BASE}/${next.slug}.html"><span>Next</span><strong>${escapeHtml(next.title)}</strong></a>` : "<span></span>"}
      </nav>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(page.title)} · Sleipnir help</title>
<meta name="description" content="${escapeHtml(page.summary)}" />
<meta property="og:title" content="${escapeHtml(page.title)} · Sleipnir help" />
<meta property="og:description" content="${escapeHtml(page.summary)}" />
<meta property="og:type" content="website" />
<link rel="icon" href="${BASE}/mark.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="${BASE}/docs.css" />
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="site-head">
  <a class="brand" href="${home}">
    <img src="${BASE}/wordmark.png" alt="Sleipnir" />
    <span class="brand-sub">help</span>
  </a>
  <div class="head-tools">
    <label class="search-wrap">
      <span class="sr-only">Search the docs</span>
      <input id="search" type="search" placeholder="Search…" autocomplete="off" spellcheck="false" />
    </label>
    <a class="ghlink" href="https://github.com/mpurdon/sleipnir" target="_blank" rel="noopener">GitHub</a>
  </div>
  <button class="nav-toggle" aria-expanded="false" aria-controls="sidenav">Menu</button>
</header>
<div id="results" class="results" hidden></div>
<div class="shell">
  <nav id="sidenav" class="sidenav" aria-label="Documentation">
    <ol>
          ${nav}
    </ol>
  </nav>
  <main id="content">
    <article class="prose">
${page.html}
    </article>
    ${pager}
    <footer class="site-foot">
      <a href="https://github.com/mpurdon/sleipnir/blob/main/docs-src/${page.slug}.md" target="_blank" rel="noopener">Edit this page</a>
      <span>·</span>
      <a href="https://github.com/mpurdon/sleipnir/issues/new" target="_blank" rel="noopener">Report a problem</a>
    </footer>
  </main>
  ${toc}
</div>
<script src="${BASE}/search.js" defer></script>
</body>
</html>
`;
}

async function main() {
  if (existsSync(OUT)) await rm(OUT, { recursive: true });
  await mkdir(OUT, { recursive: true });
  await mkdir(join(OUT, "screenshots"), { recursive: true });

  const files = (await readdir(SRC)).filter((f) => extname(f) === ".md");
  if (files.length === 0) throw new Error(`no .md files in ${SRC}`);

  const pages: Page[] = [];
  for (const file of files) {
    const raw = await readFile(join(SRC, file), "utf8");
    const { meta, body } = parseFrontMatter(raw);
    const slug = basename(file, ".md");
    if (!meta.title) throw new Error(`${file}: front matter is missing a title`);
    pages.push({
      slug,
      title: meta.title,
      order: Number(meta.order ?? 999),
      summary: meta.summary ?? "",
      ...render(body),
    });
  }
  pages.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

  for (const page of pages) {
    await writeFile(join(OUT, `${page.slug}.html`), layout(page, pages));
  }

  // Search index: title, summary, and headings per page, plus a trimmed
  // body so a phrase from the prose still finds its page.
  const index = pages.map((p) => ({
    slug: p.slug,
    title: p.title,
    summary: p.summary,
    headings: p.headings.map((h) => ({ id: h.id, text: h.text })),
    text: p.text.slice(0, 4000),
  }));
  await writeFile(join(OUT, "search-index.json"), JSON.stringify(index));

  await copyFile(join(SRC, "_assets", "docs.css"), join(OUT, "docs.css"));
  await copyFile(join(SRC, "_assets", "search.js"), join(OUT, "search.js"));
  await copyFile(join(APP_ASSETS, "sleipnir-wordmark.png"), join(OUT, "wordmark.png"));
  await copyFile(join(APP_ASSETS, "sleipnir-mark.png"), join(OUT, "mark.png"));

  for (const shot of (await readdir(SCREENSHOTS)).filter((f) => f.endsWith(".png"))) {
    await copyFile(join(SCREENSHOTS, shot), join(OUT, "screenshots", shot));
  }

  // Pages would otherwise run the output through Jekyll, which strips
  // files and directories beginning with an underscore.
  await writeFile(join(OUT, ".nojekyll"), "");

  console.log(`built ${pages.length} pages → site/`);
  for (const p of pages) console.log(`  ${String(p.order).padStart(3)}  ${p.slug}.html  ${p.title}`);
}

await main();
