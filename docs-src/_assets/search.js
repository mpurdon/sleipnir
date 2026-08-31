/*
  Help-site interactivity, dependency-free: search over a small prebuilt
  index, table-of-contents scrollspy, and the mobile nav toggle. The site is
  fully readable with this file blocked — everything here is an enhancement.
*/
(function () {
  "use strict";

  // The site is served from /sleipnir/ on Pages and from / in local
  // previews. Recover the prefix from the stylesheet rather than hardcoding
  // it, so both work from the same script.
  var cssLink = document.querySelector('link[rel="stylesheet"][href$="docs.css"]');
  var BASE = cssLink ? cssLink.getAttribute("href").replace(/\/?docs\.css$/, "") : "";

  /* ---------------- mobile nav ---------------- */

  var toggle = document.querySelector(".nav-toggle");
  var sidenav = document.getElementById("sidenav");
  if (toggle && sidenav) {
    toggle.addEventListener("click", function () {
      var open = sidenav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
  }

  /* ---------------- table overflow ---------------- */

  document.querySelectorAll(".prose table").forEach(function (table) {
    if (table.parentElement && table.parentElement.classList.contains("table-scroll")) return;
    var wrap = document.createElement("div");
    wrap.className = "table-scroll";
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  });

  /* ---------------- table-of-contents scrollspy ---------------- */

  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    var targets = [];
    tocLinks.forEach(function (a) {
      var el = document.getElementById(decodeURIComponent(a.hash.slice(1)));
      if (el) {
        byId[el.id] = a;
        targets.push(el);
      }
    });
    var visible = new Set();
    var spy = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        });
        // Highlight the first heading currently on screen; when none is
        // (mid-section scrolling), keep the last one passed.
        var current = null;
        for (var i = 0; i < targets.length; i++) {
          if (visible.has(targets[i].id)) {
            current = targets[i].id;
            break;
          }
        }
        if (!current) {
          for (var j = targets.length - 1; j >= 0; j--) {
            if (targets[j].getBoundingClientRect().top < 120) {
              current = targets[j].id;
              break;
            }
          }
        }
        tocLinks.forEach(function (a) {
          a.classList.remove("active");
        });
        if (current && byId[current]) byId[current].classList.add("active");
      },
      { rootMargin: "-70px 0px -70% 0px", threshold: 0 },
    );
    targets.forEach(function (t) {
      spy.observe(t);
    });
  }

  /* ---------------- search ---------------- */

  var input = document.getElementById("search");
  var results = document.getElementById("results");
  if (!input || !results) return;

  var index = null;
  var active = -1;
  /* One shared in-flight promise. Returning an already-resolved promise
     while the fetch was still running made every keystroke during the
     first load render against a null index — and since nothing re-rendered
     when the fetch landed, the results stayed empty until the next
     keypress. Every caller now awaits the same load. */
  var indexPromise = null;

  function load() {
    if (!indexPromise) {
      indexPromise = fetch(BASE + "/search-index.json")
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (data) {
          index = data;
        })
        .catch(function () {
          // Leave search inert rather than throwing on every keystroke.
          index = [];
        });
    }
    return indexPromise;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Scores a page against the query terms. Title and heading matches weigh
   * heaviest so "projects" lands on the Projects page rather than on every
   * page that happens to mention projects.
   */
  function score(page, terms) {
    var title = page.title.toLowerCase();
    var summary = (page.summary || "").toLowerCase();
    var text = page.text.toLowerCase();
    var headings = page.headings.map(function (h) {
      return h.text.toLowerCase();
    });

    var total = 0;
    var hitHeading = null;

    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      var termScore = 0;
      if (title === t) termScore += 120;
      else if (title.indexOf(t) !== -1) termScore += 60;
      if (summary.indexOf(t) !== -1) termScore += 20;
      for (var h = 0; h < headings.length; h++) {
        if (headings[h].indexOf(t) !== -1) {
          termScore += 30;
          if (!hitHeading) hitHeading = page.headings[h];
          break;
        }
      }
      var idx = text.indexOf(t);
      if (idx !== -1) termScore += 10;
      // Every term must appear somewhere, so a two-word query narrows
      // instead of widening.
      if (termScore === 0) return null;
      total += termScore;
    }
    return { score: total, heading: hitHeading };
  }

  function snippet(page, terms) {
    var text = page.text;
    var lower = text.toLowerCase();
    var at = -1;
    for (var i = 0; i < terms.length && at === -1; i++) at = lower.indexOf(terms[i]);
    if (at === -1) return escapeHtml(page.summary || text.slice(0, 130));
    var start = Math.max(0, at - 50);
    var raw = (start > 0 ? "…" : "") + text.slice(start, start + 150) + "…";
    var out = escapeHtml(raw);
    terms.forEach(function (t) {
      out = out.replace(new RegExp("(" + escapeRe(escapeHtml(t)) + ")", "ig"), "<mark>$1</mark>");
    });
    return out;
  }

  function render(query) {
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length || !index) {
      results.hidden = true;
      results.innerHTML = "";
      active = -1;
      return;
    }

    var hits = [];
    index.forEach(function (page) {
      var s = score(page, terms);
      if (s) hits.push({ page: page, score: s.score, heading: s.heading });
    });
    hits.sort(function (a, b) {
      return b.score - a.score;
    });
    hits = hits.slice(0, 8);

    if (!hits.length) {
      results.innerHTML = '<p class="r-empty">No matches for “' + escapeHtml(query) + '”.</p>';
      results.hidden = false;
      active = -1;
      return;
    }

    results.innerHTML = hits
      .map(function (h) {
        var href = BASE + "/" + h.page.slug + ".html" + (h.heading ? "#" + h.heading.id : "");
        var title = escapeHtml(h.page.title) + (h.heading ? ' <span style="color:var(--c-dim)">› ' + escapeHtml(h.heading.text) + "</span>" : "");
        return (
          '<a href="' + href + '"><span class="r-title">' + title + '</span>' +
          '<span class="r-ctx">' + snippet(h.page, terms) + "</span></a>"
        );
      })
      .join("");
    results.hidden = false;
    active = -1;
  }

  function items() {
    return Array.prototype.slice.call(results.querySelectorAll("a"));
  }

  function setActive(next) {
    var list = items();
    if (!list.length) return;
    if (active >= 0 && list[active]) list[active].classList.remove("active");
    active = (next + list.length) % list.length;
    list[active].classList.add("active");
    list[active].scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("focus", load);
  input.addEventListener("input", function () {
    load().then(function () {
      render(input.value.trim());
    });
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === "Enter") {
      var list = items();
      if (active >= 0 && list[active]) {
        e.preventDefault();
        window.location.href = list[active].getAttribute("href");
      }
    } else if (e.key === "Escape") {
      input.value = "";
      render("");
      input.blur();
    }
  });

  document.addEventListener("click", function (e) {
    if (!results.contains(e.target) && e.target !== input) {
      results.hidden = true;
      active = -1;
    }
  });

  // "/" focuses search from anywhere, the way most docs sites behave.
  document.addEventListener("keydown", function (e) {
    var tag = (e.target.tagName || "").toLowerCase();
    if (e.key === "/" && tag !== "input" && tag !== "textarea" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
})();
