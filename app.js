"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("ficshelf." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ficshelf." + k, JSON.stringify(v)); } catch {} },
};
function toast(msg, ms = 3200) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
const fmtNum = n => (n == null ? "—" : n.toLocaleString());
const fmtBytes = b => !b ? "0 MB" : b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";
const RATING = { "General Audiences": "G", "Teen And Up Audiences": "T", "Mature": "M", "Explicit": "E", "Not Rated": "N" };
const ratingLetter = r => RATING[r] || (r ? r[0].toUpperCase() : "?");

/* ------------------------------------------------------------ state */
const S = {
  items: [], groups: [], sources: [],
  shelf: "all", q: "", facets: {}, sort: store.get("sort", "added"), view: store.get("view", "cards"),
  shown: 0, filtered: [],
};
const SHELVES = [
  ["all", "All fics"], ["continue", "Continue reading"], ["favorites", "Favorites"], ["downloaded", "Downloaded"],
  ["to-read", "To read"], ["reading", "Reading"], ["finished", "Finished"], ["attention", "Needs attention"],
];
const FACETS = [
  // key, label, getter -> array, mode (any|all)
  ["rating", "Rating", g => g.rating ? [g.rating] : [], "any"],
  ["category", "Category", g => g.category || [], "any"],
  ["status", "Status", g => g.complete == null ? [] : [g.complete ? "Complete" : "Work in progress"], "any"],
  ["length", "Length", g => g.words == null ? [] : [lengthBucket(g.words)], "any"],
  ["fandoms", "Fandom", g => g.fandoms || [], "all"],
  ["relationships", "Relationship", g => g.relationships || [], "all"],
  ["characters", "Characters", g => g.characters || [], "all"],
  ["tags", "Tags", g => g.tags || [], "all"],
  ["warnings", "Archive warnings", g => g.warnings || [], "any"],
  ["format", "Format", g => g.formats.map(f => f.kind.toUpperCase()), "any"],
  ["source", "Source", g => [g.sourceName], "any"],
];
const LENGTHS = ["Under 5K", "5K–20K", "20K–50K", "50K–100K", "100K+"];
function lengthBucket(w) { return w < 5000 ? LENGTHS[0] : w < 20000 ? LENGTHS[1] : w < 50000 ? LENGTHS[2] : w < 100000 ? LENGTHS[3] : LENGTHS[4]; }
const facetOpen = store.get("facetOpen", { rating: true, category: true, status: true, fandoms: true, relationships: true, characters: true, tags: true });
const facetSearch = {}; const facetExpanded = {};

/* ------------------------------------------------------------ data */
function buildGroups() {
  const srcName = Object.fromEntries(S.sources.map(s => [s.id, s.name]));
  const map = new Map();
  for (const it of S.items) {
    const key = it.work_id ? "w" + it.work_id : "i" + it.id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  S.groups = [...map.values()].map(members => {
    const score = m => (m.status === "ok" ? 4 : 0) + (m.kind === "epub" ? 2 : 0) + (m.downloaded ? 1 : 0);
    const p = [...members].sort((a, b) => score(b) - score(a))[0];
    const g = { ...p, members, formats: members.map(m => ({ id: m.id, kind: m.kind, downloaded: m.downloaded })) };
    g.favorite = members.some(m => m.favorite);
    g.downloaded = members.some(m => m.downloaded);
    g.progress = Math.max(...members.map(m => m.progress || 0));
    g.last_opened = Math.max(...members.map(m => m.last_opened || 0));
    g.shelf = members.find(m => m.shelf)?.shelf || "";
    g.sourceName = p.source_id ? (srcName[p.source_id] || "Drive folder") : "Imported";
    g.hay = [g.title, g.author, g.series, g.filename, g.summary, ...(g.fandoms || []), ...(g.relationships || []),
      ...(g.characters || []), ...(g.tags || [])].join(" \u0001 ").toLowerCase();
    return g;
  });
}
function inShelf(g, shelf) {
  switch (shelf) {
    case "continue": return g.progress > 0.01 && g.progress < 0.98;
    case "favorites": return g.favorite;
    case "downloaded": return g.downloaded;
    case "to-read": case "reading": case "finished": return g.shelf === shelf;
    case "attention": return g.status !== "ok";
    default: return true;
  }
}
function matches(g, skipFacet) {
  if (!inShelf(g, S.shelf)) return false;
  if (S.q) { for (const w of S.q.toLowerCase().split(/\s+/).filter(Boolean)) if (!g.hay.includes(w)) return false; }
  for (const [key, , get, mode] of FACETS) {
    if (key === skipFacet) continue;
    const sel = S.facets[key]; if (!sel || !sel.size) continue;
    const vals = get(g);
    if (mode === "all" ? ![...sel].every(v => vals.includes(v)) : !vals.some(v => sel.has(v))) return false;
  }
  return true;
}
const SORTS = {
  added: (a, b) => (b.added_at || 0) - (a.added_at || 0),
  opened: (a, b) => (b.last_opened || 0) - (a.last_opened || 0),
  updated: (a, b) => (b.updated || "").localeCompare(a.updated || ""),
  title: (a, b) => (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }),
  author: (a, b) => (a.author || "").localeCompare(b.author || "", undefined, { sensitivity: "base" }),
  words_desc: (a, b) => (b.words || 0) - (a.words || 0),
  words_asc: (a, b) => (a.words ?? 1e12) - (b.words ?? 1e12),
};

/* ------------------------------------------------------------ render library */
function render() {
  S.filtered = S.groups.filter(g => matches(g)).sort(SORTS[S.sort] || SORTS.added);
  renderShelves(); renderFacets(); renderActive();
  $("#count").textContent = `${S.filtered.length.toLocaleString()} ${S.filtered.length === 1 ? "fic" : "fics"}`;
  const list = $("#list"); list.className = S.view === "rows" ? "rows" : "cards"; list.innerHTML = "";
  $$(".seg [data-view]").forEach(b => b.classList.toggle("on", b.dataset.view === S.view));
  S.shown = 0; renderMore();
  $("#empty").hidden = S.groups.length > 0;
}
function renderMore() {
  const next = S.filtered.slice(S.shown, S.shown + 60);
  $("#list").insertAdjacentHTML("beforeend", next.map(card).join(""));
  S.shown += next.length;
}
function chips(arr, field, max) {
  if (!arr || !arr.length) return "";
  const shown = arr.slice(0, max);
  return `<div class="chips ${field}">${shown.map(v => `<button class="chip" data-f="${field}" data-v="${esc(v)}">${esc(v)}</button>`).join("")}${arr.length > max ? `<span class="chip more">+${arr.length - max}</span>` : ""}</div>`;
}
function card(g) {
  const pending = g.status !== "ok";
  const letter = pending ? "?" : ratingLetter(g.rating);
  const meta = [];
  if (g.words != null) meta.push(`${fmtNum(g.words)} words`);
  if (g.chapters) meta.push(`Ch ${esc(g.chapters)}`);
  if (g.complete === false) meta.push(`<span class="wip">WIP</span>`);
  meta.push(g.formats.map(f => f.kind.toUpperCase()).join(" · "));
  if (g.downloaded) meta.push(`<span class="dl" title="Available offline">● Offline</span>`);
  if (g.favorite) meta.push(`<span class="fav">♥</span>`);
  if (pending) meta.push(g.status === "error" ? `<span class="err">Couldn't read details</span>` : `Reading details…`);
  return `<div class="card" data-id="${g.id}" tabindex="0">
    <div class="rating-cell"><span class="rating ${letter}" title="${esc(g.rating)}">${letter}</span></div>
    <div class="card-head"><span class="rating ${letter}" title="${esc(g.rating)}">${letter}</span>
      <div class="col-main"><h3>${esc(g.title)}</h3><div class="byline">${g.author ? "by " + esc(g.author) : esc(g.folder || "")}</div></div></div>
    <div class="col-fan"><div class="fandom" title="${esc((g.fandoms || []).join(", "))}">${esc((g.fandoms || []).join(" · "))}</div></div>
    <div class="col-rel">${g.relationships?.length ? `<div class="rel">${esc(g.relationships.slice(0, 2).join(", "))}${g.relationships.length > 2 ? ` +${g.relationships.length - 2}` : ""}</div>` : ""}
      ${chips(g.characters, "characters", 4)}</div>
    ${chips(g.tags, "tags", 6)}
    ${g.summary ? `<div class="summary">${esc(g.summary)}</div>` : ""}
    ${g.progress > 0.01 ? `<div class="pbar"><div style="width:${Math.round(g.progress * 100)}%"></div></div>` : ""}
    <div class="meta-row">${meta.join("<span>·</span>")}</div>
  </div>`;
}
function counts(key) {
  const f = FACETS.find(x => x[0] === key), m = new Map();
  for (const g of S.groups) if (matches(g, key)) for (const v of new Set(f[2](g))) m.set(v, (m.get(v) || 0) + 1);
  for (const v of S.facets[key] || []) if (!m.has(v)) m.set(v, 0);
  return m;
}
function renderShelves() {
  $("#shelves").innerHTML = SHELVES.map(([k, label]) => {
    const n = S.groups.filter(g => inShelf(g, k)).length;
    if (k === "attention" && !n) return "";
    return `<a data-shelf="${k}" class="${S.shelf === k ? "on" : ""}"><span>${label}</span><span class="n">${n.toLocaleString()}</span></a>`;
  }).join("");
}
function renderFacets() {
  const order = { rating: Object.keys(RATING), length: LENGTHS };
  $("#facets").innerHTML = FACETS.map(([key, label]) => {
    const c = counts(key); if (!c.size) return "";
    const sel = S.facets[key] || new Set(); const open = facetOpen[key];
    let entries = [...c.entries()];
    if (order[key]) entries.sort((a, b) => order[key].indexOf(a[0]) - order[key].indexOf(b[0]));
    else entries.sort((a, b) => (sel.has(b[0]) - sel.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]));
    const fq = (facetSearch[key] || "").toLowerCase();
    if (fq) entries = entries.filter(([v]) => v.toLowerCase().includes(fq));
    const limit = facetExpanded[key] ? 400 : 8; const big = c.size > 12;
    return `<div class="facet" data-key="${key}">
      <h4 data-toggle="${key}"><span>${label}${sel.size ? ` · ${sel.size}` : ""}</span><span>${open ? "−" : "+"}</span></h4>
      ${open ? `${big ? `<input data-fsearch="${key}" placeholder="Filter ${label.toLowerCase()}…" value="${esc(facetSearch[key] || "")}">` : ""}
      ${entries.slice(0, limit).map(([v, n]) => `<label><input type="checkbox" data-f="${key}" data-v="${esc(v)}" ${sel.has(v) ? "checked" : ""}><span class="t">${esc(v)}</span><span class="n">${n}</span></label>`).join("")}
      ${entries.length > limit ? `<button class="more-btn" data-expand="${key}">Show all ${entries.length}</button>` : facetExpanded[key] && entries.length > 8 ? `<button class="more-btn" data-expand="${key}">Show fewer</button>` : ""}` : ""}
    </div>`;
  }).join("");
}
function renderActive() {
  const out = [];
  for (const [key, label] of FACETS) for (const v of S.facets[key] || []) out.push(`<span class="fchip">${esc(v)}<button data-rm="${key}" data-v="${esc(v)}" aria-label="Remove">✕</button></span>`);
  if (out.length) out.push(`<button class="btn ghost" id="clearFilters" style="padding:2px 8px;font-size:12px">Clear</button>`);
  $("#activeFilters").innerHTML = out.join("");
}
function toggleFacet(key, v, on) {
  S.facets[key] = S.facets[key] || new Set();
  (on ?? !S.facets[key].has(v)) ? S.facets[key].add(v) : S.facets[key].delete(v);
  render();
}

/* ------------------------------------------------------------ loading */
async function loadAll() {
  [S.items, S.sources] = await Promise.all([api("/api/items"), api("/api/sources")]);
  buildGroups(); render(); renderBanner();
}
async function refreshQuiet() {
  const [items, sources] = await Promise.all([api("/api/items"), api("/api/sources")]);
  S.sources = sources; renderBanner();
  if (JSON.stringify(items) !== JSON.stringify(S.items)) {
    S.items = items; buildGroups();
    const keep = S.shown; render(); while (S.shown < keep && S.shown < S.filtered.length) renderMore();
  }
  if (!$("#sourcesModal").hidden) renderSources();
}
function renderBanner() {
  const scanning = S.sources.filter(s => s.status === "scanning");
  const b = $("#scanBanner");
  if (!scanning.length) { b.hidden = true; return; }
  const s = scanning[0]; const todo = (s.counts.pending || 0) + s.done + s.failed;
  const pct = todo ? Math.round(((s.done + s.failed) / todo) * 100) : 5;
  b.hidden = false;
  b.innerHTML = `<strong>Scanning ${esc(s.name)}</strong><button class="btn" data-pause="${s.id}" style="padding:3px 10px;font-size:12px">Pause</button><span class="muted">${esc(s.message)} · ${s.found} files found</span><div class="bar"><div style="width:${pct}%"></div></div>`;
}
let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = S.sources.some(s => s.status === "scanning");
  pollTimer = setTimeout(async () => { try { await refreshQuiet(); } catch {} schedulePoll(); }, busy ? 2500 : 15000);
}

/* ------------------------------------------------------------ drawer */
let drawerId = null;
async function openDrawer(id) {
  drawerId = id;
  const g = S.groups.find(x => x.members.some(m => m.id === id));
  const it = await api(`/api/items/${id}`);
  const members = g ? g.members : [it];
  const sec = (label, arr, field) => arr && arr.length ? `<div class="d-sec"><h4>${label}</h4>${chips(arr, field, 999)}</div>` : "";
  const ao3 = it.work_id ? `https://archiveofourown.org/works/${it.work_id}` : "";
  $("#drawer").innerHTML = `
    <div class="d-head">
      <button class="icon-btn d-close" data-close-drawer aria-label="Close">✕</button>
      <div class="chips">${it.rating ? `<span class="rating ${ratingLetter(it.rating)}" style="width:auto;padding:0 8px;height:22px;font-size:11px">${esc(it.rating)}</span>` : ""}
        ${(it.category || []).map(c => `<span class="chip">${esc(c)}</span>`).join("")}
        ${it.complete != null ? `<span class="chip">${it.complete ? "Complete" : "Work in progress"}</span>` : ""}</div>
      <h2>${esc(it.title)}</h2>
      <div class="byline">${it.author ? "by " + esc(it.author) : ""}${it.series ? ` · ${esc(it.series)}` : ""}</div>
      <div class="d-actions">
        ${members.map(m => `<button class="btn primary" data-read="${m.id}">${m.downloaded ? "Read" : "Download & read"}${members.length > 1 ? " " + m.kind.toUpperCase() : ""}</button>`).join("")}
        <button class="btn" data-fav="${id}">${it.favorite ? "♥ Favorited" : "♡ Favorite"}</button>
        <select data-shelfsel="${id}" class="btn" aria-label="Shelf">
          ${[["", "No shelf"], ["to-read", "To read"], ["reading", "Reading"], ["finished", "Finished"]].map(([v, l]) => `<option value="${v}" ${it.shelf === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="d-body">
      ${it.status !== "ok" ? `<div class="d-sec"><h4>Status</h4><p class="muted">${it.status === "error" ? "Couldn't read this file's details: " + esc(it.error) : "Details are still being read."}</p><button class="btn" data-rescan="${id}">Try again</button></div>` : ""}
      ${it.summary ? `<div class="d-sec"><h4>Summary</h4><div class="d-summary">${esc(it.summary)}</div></div>` : ""}
      <div class="d-sec"><div class="stats">
        <div class="stat"><b>${fmtNum(it.words)}</b><span>Words</span></div>
        <div class="stat"><b>${esc(it.chapters || "—")}</b><span>Chapters</span></div>
        <div class="stat"><b>${esc(it.published || "—")}</b><span>Published</span></div>
        <div class="stat"><b>${esc(it.updated || "—")}</b><span>Updated</span></div>
        ${it.progress > 0.01 ? `<div class="stat"><b>${Math.round(it.progress * 100)}%</b><span>Read</span></div>` : ""}
      </div></div>
      ${sec("Fandoms", it.fandoms, "fandoms")}
      ${sec("Relationships", it.relationships, "relationships")}
      ${sec("Characters", it.characters, "characters")}
      ${sec("Additional tags", it.tags, "tags")}
      ${sec("Archive warnings", it.warnings, "warnings")}
      ${it.collections?.length ? `<div class="d-sec"><h4>Collections</h4><div class="muted" style="font-size:12px">${esc(it.collections.join(" · "))}</div></div>` : ""}
      <div class="d-sec"><h4>Files</h4>
        ${members.map(m => `<div class="file-info" style="margin-bottom:8px">${m.kind.toUpperCase()} · ${esc(m.filename)} · ${fmtBytes(m.size)} · ${esc(m.folder || "")}<br>
          ${m.downloaded ? `<span style="color:var(--r-g)">Available offline</span>${m.pinned ? " · kept offline" : ""}
            · <a href="#" data-pin="${m.id}" data-on="${m.pinned ? 0 : 1}">${m.pinned ? "Allow auto-removal" : "Keep offline"}</a>
            ${m.source_id ? ` · <a href="#" data-unload="${m.id}">Remove download</a>` : ""}` : "Not downloaded"}</div>`).join("")}
        ${ao3 ? `<a href="${ao3}" target="_blank" rel="noopener" class="file-info">${ao3}</a>` : ""}
      </div>
    </div>`;
  $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden", "false"); $("#scrim").hidden = false;
}
function closeDrawer() { $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); $("#scrim").hidden = true; drawerId = null; }
async function patchItem(id, body) {
  await api(`/api/items/${id}`, { method: "PATCH", json: body });
  await refreshQuiet(); if (drawerId) openDrawer(drawerId);
}

/* ------------------------------------------------------------ reader */
const R = { id: null, fs: store.get("fs", 19), rt: store.get("rt", "light"), rw: store.get("rw", "full"), saveT: null, chapters: [] };
const WIDTHS = { full: "Full", wide: "Wide", narrow: "Narrow" };
function applyWidth() { $("#reader").dataset.rw = R.rw; $("#widthBtn").textContent = "Width: " + WIDTHS[R.rw]; }
async function openReader(id) {
  closeDrawer();
  const it = S.items.find(x => x.id === id);
  R.id = id;
  const reader = $("#reader"); reader.hidden = false; reader.dataset.rt = R.rt; applyWidth();
  $$("#readerTheme button").forEach(b => b.classList.toggle("on", b.dataset.rt === R.rt));
  $("#readerTitle").textContent = it ? it.title : "";
  const book = $("#book"); $("#readerScroll").hidden = false;
  if (R.pdf) { try { R.pdf.destroy(); } catch {} R.pdf = null; } if (R.io) { R.io.disconnect(); R.io = null; }
  book.style.setProperty("--fs", R.fs + "px");
  F.marks = []; F.i = -1; F.q = ""; $("#findQ").value = ""; $("#findCount").textContent = ""; $("#findForm").hidden = false;
  book.innerHTML = `<div class="loading">${it && !it.downloaded ? "Downloading from Google Drive…" : "Opening…"}<br><span id="dlprog"></span></div>`;
  const prog = setInterval(async () => {
    try { const p = await api(`/api/items/${id}/download-progress`); if (p.total) $("#dlprog") && ($("#dlprog").textContent = `${fmtBytes(p.done)} of ${fmtBytes(p.total)}`); } catch {}
  }, 700);
  try {
    const data = await api(`/api/items/${id}/book`);
    clearInterval(prog);
    if (it && !it.shelf) api(`/api/items/${id}`, { method: "PATCH", json: { shelf: "reading" } });
    if (data.kind === "pdf") {
      $("#fontUp").hidden = $("#fontDown").hidden = true; $("#findForm").hidden = true;
      $("#chapterSel").hidden = false; $("#widthBtn").hidden = false;
      await renderPdf(data.data, it);
    } else {
      $("#chapterSel").hidden = false; $("#fontUp").hidden = $("#fontDown").hidden = $("#widthBtn").hidden = false;
      R.chapters = data.chapters;
      book.innerHTML = data.chapters.map((c, i) => `<section class="chapter" id="ch${i}">${c.html}</section>`).join("");
      $$("img", book).forEach(img => { const p = img.getAttribute("src"); if (p && p.startsWith("res?")) img.src = `/api/items/${id}/${p}`; });
      $("#chapterSel").innerHTML = data.chapters.map((c, i) => `<option value="${i}">${esc(c.title)}</option>`).join("");
      const sc = $("#readerScroll");
      requestAnimationFrame(() => { if (it && it.progress > 0.01 && it.progress < 0.99) sc.scrollTop = it.progress * (sc.scrollHeight - sc.clientHeight); onReaderScroll(); });
    }
    refreshQuiet();
  } catch (e) {
    clearInterval(prog);
    book.innerHTML = `<div class="loading">Couldn't open this fic.<br><small>${esc(e.message)}</small></div>`;
  }
}
function closeReader() {
  $("#reader").hidden = true; saveProgress(); R.id = null;
  if (R.pdf) { try { R.pdf.destroy(); } catch {} R.pdf = null; }
  if (R.io) { R.io.disconnect(); R.io = null; }
  $("#book").innerHTML = ""; refreshQuiet();
}
async function renderPdf(data, it) {
  const book = $("#book");
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  R.pdf = doc;
  const vp1 = (await doc.getPage(1)).getViewport({ scale: 1 });
  book.innerHTML = Array.from({ length: doc.numPages }, (_, i) =>
    `<section class="chapter pdf-page" id="ch${i}" data-page="${i + 1}" style="aspect-ratio:${vp1.width}/${vp1.height}"></section>`).join("");
  $("#chapterSel").innerHTML = Array.from({ length: doc.numPages }, (_, i) => `<option value="${i}">Page ${i + 1} of ${doc.numPages}</option>`).join("");
  const draw = async el => {
    const page = await doc.getPage(+el.dataset.page);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (el.clientWidth / vp0.width) * Math.min(2, window.devicePixelRatio || 1) });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
    el.appendChild(c);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  };
  R.io = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting && !e.target.dataset.done) { e.target.dataset.done = "1"; draw(e.target).catch(() => {}); }
  }), { root: $("#readerScroll"), rootMargin: "1200px 0px" });
  $$(".pdf-page", book).forEach(el => R.io.observe(el));
  const sc = $("#readerScroll");
  requestAnimationFrame(() => { if (it && it.progress > 0.01 && it.progress < 0.99) sc.scrollTop = it.progress * (sc.scrollHeight - sc.clientHeight); onReaderScroll(); });
}
function onReaderScroll() {
  const sc = $("#readerScroll"); const max = sc.scrollHeight - sc.clientHeight;
  const frac = max > 0 ? sc.scrollTop / max : 0;
  $("#readerProgress").style.width = (frac * 100).toFixed(1) + "%";
  const secs = $$(".chapter", $("#book")); let cur = 0;
  for (let i = 0; i < secs.length; i++) if (secs[i].offsetTop - 80 <= sc.scrollTop) cur = i;
  $("#chapterSel").value = String(cur);
  clearTimeout(R.saveT); R.saveT = setTimeout(saveProgress, 900);
}
function saveProgress() {
  if (!R.id || $("#readerScroll").hidden) return;
  const sc = $("#readerScroll"); const max = sc.scrollHeight - sc.clientHeight;
  if (max <= 0) return;
  const frac = Math.min(1, sc.scrollTop / max);
  const body = { progress: frac }; if (frac > 0.985) body.shelf = "finished";
  api(`/api/items/${R.id}`, { method: "PATCH", json: body }).catch(() => {});
}

/* ------------------------------------------------------------ sources modal */
function openSources() { $("#sourcesModal").hidden = false; renderSources(); loadSettings(); }
function renderSources() {
  $("#sourceList").innerHTML = S.sources.length ? S.sources.map(s => {
    const c = s.counts || {}; const total = (c.ok || 0) + (c.pending || 0) + (c.error || 0);
    const pct = total ? Math.round(((c.ok || 0) + (c.error || 0)) / total * 100) : 0;
    return `<div class="src">
      <div class="src-top"><div class="src-name">${esc(s.name)}</div>
        <div class="src-btns">
          ${s.status === "scanning" ? `<button class="btn" data-pause="${s.id}">Pause</button>` : `<button class="btn" data-sync="${s.id}">${(c.pending || 0) ? "Continue scan" : "Sync"}</button>`}
          ${c.error ? `<button class="btn" data-retry="${s.id}" ${s.status === "scanning" ? "disabled" : ""}>Retry ${c.error} failed</button>` : ""}
          <button class="btn danger" data-rmsrc="${s.id}">Remove</button></div></div>
      <div class="src-msg">${(c.ok || 0).toLocaleString()} read · ${(c.pending || 0).toLocaleString()} waiting · ${(c.error || 0).toLocaleString()} failed — ${esc(s.message || "")}</div>
      ${s.status === "scanning" ? `<div class="bar"><div style="width:${pct}%"></div></div>` : ""}
      <div class="file-info"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></div>
    </div>`;
  }).join("") : `<p class="muted">No Drive folders yet.</p>`;
}
async function loadSettings() {
  const s = await api("/api/settings");
  $("#apiKey").value = s.api_key || "";
  $("#apiKey").placeholder = s.has_builtin_key ? "Built in — leave empty" : "Needed to read Google Drive folders";
  $("#keyNote").hidden = !!(s.has_builtin_key || s.api_key);
  $("#cacheLimit").value = String(s.cache.limit_mb);
  $("#cacheUse").textContent = `${s.cache.files} files downloaded · ${fmtBytes(s.cache.bytes)} used${s.cache.limit_mb ? ` of ${fmtBytes(s.cache.limit_mb * 1048576)}` : ""}. Fics you haven't opened in the longest time are removed first when the limit is reached; "Keep offline" fics are never removed.` +
    (s.storage && s.storage.quota ? ` This browser allows this site about ${fmtBytes(s.storage.quota)}.` : "");
}
async function uploadFiles(files) {
  const list = [...files].filter(f => /\.(epub|pdf)$/i.test(f.name));
  if (!list.length) return toast("Only EPUB and PDF files can be imported.");
  toast(`Importing ${list.length} file(s)…`, 10000);
  for (let i = 0; i < list.length; i += 20) {
    const fd = new FormData(); list.slice(i, i + 20).forEach(f => fd.append("files", f));
    const r = await api("/api/upload", { method: "POST", body: fd });
    if (r.errors.length) toast(r.errors[0]);
  }
  toast(`Imported ${list.length} file(s).`); refreshQuiet();
}

/* ------------------------------------------------------------ theme */
const THEMES = [
  { id: "blossom", name: "Blossom Bliss", tag: "rose petals & peach fizz", colors: ["#f0508a", "#ff8a5b", "#c9b3ff", "#fff6f8"], grad: "linear-gradient(135deg,#f0508a,#ff8a5b)" },
  { id: "matcha", name: "Matcha Honey", tag: "sage leaves, warm honey drizzle", colors: ["#6D9773", "#0C3B2E", "#BB8A52", "#FFBA00"], grad: "linear-gradient(135deg,#0C3B2E,#6D9773 55%,#FFBA00)" },
  { id: "lavender", name: "Lavender Haze", tag: "after-midnight purple glow", colors: ["#2A2438", "#352F44", "#5C5470", "#DBD8E3"], grad: "linear-gradient(135deg,#2A2438,#5C5470 50%,#DBD8E3)" },
  { id: "sunset", name: "Sunkissed Sorbet", tag: "coral, tomato jam & sky", colors: ["#F6FFEA", "#FFDE96", "#FA855A", "#C93638", "#62C4DA"], grad: "linear-gradient(135deg,#FFDE96,#FA855A 45%,#C93638)" },
  { id: "peony", name: "Peony Latte", tag: "blush, rosewood & vanilla cream", colors: ["#FFF7E6", "#F7C8D3", "#B46A72", "#A8B58A", "#A9B7C6", "#2D3A47"], grad: "linear-gradient(135deg,#F7C8D3,#B46A72 60%,#2D3A47)" },
];
function currentTheme() { const t = store.get("theme", "blossom"); return THEMES.some(x => x.id === t) ? t : "blossom"; }
function applyTheme() {
  const t = currentTheme(); document.documentElement.dataset.theme = t;
  $("#themeName").textContent = THEMES.find(x => x.id === t).name;
}
function renderThemePop() {
  const cur = currentTheme();
  $("#themePop").innerHTML = `<h3>Pick your vibe</h3>` + THEMES.map(t => `
    <button class="theme-opt ${t.id === cur ? "on" : ""}" data-theme-id="${t.id}">
      <span class="pv" style="background:${t.grad}"><span class="dots">${t.colors.map(c => `<i style="background:${c}"></i>`).join("")}</span></span>
      <span><b>${t.name}</b><small>${t.tag}</small></span>
    </button>`).join("");
}
$("#themeBtn").onclick = e => { e.stopPropagation(); const p = $("#themePop"); if (p.hidden) { renderThemePop(); p.hidden = false; } else p.hidden = true; };
$("#themePop").addEventListener("click", e => {
  e.stopPropagation(); const b = e.target.closest("[data-theme-id]"); if (!b) return;
  store.set("theme", b.dataset.themeId); applyTheme(); renderThemePop();
});
document.addEventListener("click", () => { $("#themePop").hidden = true; });

/* ------------------------------------------------------------ events */
document.addEventListener("click", async e => {
  const t = e.target.closest("button, a, [data-shelf], .card, input[type=checkbox]") || e.target;
  const d = t.dataset || {};
  try {
    if (d.f && d.v != null && t.matches("button.chip")) { e.stopPropagation(); closeDrawer(); toggleFacet(d.f, d.v, true); window.scrollTo(0, 0); return; }
    if (t.matches("input[type=checkbox][data-f]")) { toggleFacet(d.f, d.v, t.checked); return; }
    if (d.shelf) { S.shelf = d.shelf; render(); $("#sidebar").classList.remove("open"); return; }
    if (d.toggle) { facetOpen[d.toggle] = !facetOpen[d.toggle]; store.set("facetOpen", facetOpen); renderFacets(); return; }
    if (d.expand) { facetExpanded[d.expand] = !facetExpanded[d.expand]; renderFacets(); return; }
    if (d.rm) { S.facets[d.rm]?.delete(d.v); render(); return; }
    if (t.id === "clearFilters") { S.facets = {}; render(); return; }
    if (t.matches(".card")) { openDrawer(+d.id); return; }
    if (d.closeDrawer !== undefined || t.id === "scrim") { closeDrawer(); return; }
    if (d.read) { openReader(+d.read); return; }
    if (d.fav) { const it = S.items.find(x => x.id === +d.fav); await patchItem(+d.fav, { favorite: it && it.favorite ? 0 : 1 }); return; }
    if (d.pin) { e.preventDefault(); await patchItem(+d.pin, { pinned: +d.on }); return; }
    if (d.unload) { e.preventDefault(); await api(`/api/items/${d.unload}/download`, { method: "DELETE" }); toast("Download removed. It stays in your library."); await refreshQuiet(); openDrawer(drawerId); return; }
    if (d.rescan) { t.disabled = true; await api(`/api/items/${d.rescan}/rescan`, { method: "POST" }); await refreshQuiet(); openDrawer(+d.rescan); return; }
    if (d.sync) { await api(`/api/sources/${d.sync}/sync`, { method: "POST" }); await refreshQuiet(); schedulePoll(); return; }
    if (d.retry) { await api(`/api/sources/${d.retry}/sync?retry=1`, { method: "POST" }); await refreshQuiet(); schedulePoll(); return; }
    if (d.pause) { t.disabled = true; await api(`/api/sources/${d.pause}/pause`, { method: "POST" }); toast("Pausing… fics read so far stay in your library."); await refreshQuiet(); return; }
    if (d.rmsrc) {
      const src = S.sources.find(x => x.id === +d.rmsrc) || {};
      const n = Object.values(src.counts || {}).reduce((a, b) => a + b, 0);
      const dl = S.items.filter(i => i.source_id === +d.rmsrc && i.downloaded).length;
      if (!confirm(`Remove "${src.name}" and its ${n.toLocaleString()} fics from your library?\n\nTo stop scanning but keep the fics, press Cancel and use Pause instead.` + (dl ? `\n\nYour ${dl} downloaded fic(s) will be kept.` : ""))) return;
      await api(`/api/sources/${d.rmsrc}?keep_downloads=1`, { method: "DELETE" }); await refreshQuiet(); return;
    }
    if (d.close !== undefined) { $("#sourcesModal").hidden = true; return; }
  } catch (err) { toast(err.message); }
});
document.addEventListener("change", async e => {
  if (e.target.dataset.shelfsel) await patchItem(+e.target.dataset.shelfsel, { shelf: e.target.value }).catch(err => toast(err.message));
});
document.addEventListener("input", e => {
  const k = e.target.dataset.fsearch;
  if (k) { facetSearch[k] = e.target.value; renderFacets(); const inp = $(`[data-fsearch="${k}"]`); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && e.target.id === "findQ") return;
  if (e.key === "Escape") { if (!$("#reader").hidden) closeReader(); else if (drawerId) closeDrawer(); else $("#sourcesModal").hidden = true; }
  if (e.key === "Enter" && e.target.matches(".card")) openDrawer(+e.target.dataset.id);
  if (e.key === "/" && document.activeElement.tagName !== "INPUT" && $("#reader").hidden) { e.preventDefault(); $("#q").focus(); }
});
$("#searchForm").onsubmit = e => { e.preventDefault(); clearTimeout(qT); S.q = $("#q").value.trim(); render(); window.scrollTo(0, 0); };
let qT; $("#q").addEventListener("input", e => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value.trim(); render(); }, 150); });
$("#sort").value = S.sort; $("#sort").onchange = e => { S.sort = e.target.value; store.set("sort", S.sort); render(); };
$$(".seg [data-view]").forEach(b => b.onclick = () => { S.view = b.dataset.view; store.set("view", S.view); render(); });
$("#toggleSidebar").onclick = () => $("#sidebar").classList.toggle("open");
$("#openSources").onclick = openSources; $("#emptyAdd").onclick = openSources;
$("#sourcesModal").addEventListener("click", e => { if (e.target.id === "sourcesModal") $("#sourcesModal").hidden = true; });
$("#addSource").onsubmit = async e => {
  e.preventDefault(); const url = $("#sourceUrl").value.trim(); if (!url) return;
  const btn = e.target.querySelector("button"); btn.disabled = true;
  try { await api("/api/sources", { method: "POST", json: { url } }); $("#sourceUrl").value = ""; toast("Folder added. Scanning…"); await refreshQuiet(); schedulePoll(); }
  catch (err) { toast(err.message); } finally { btn.disabled = false; }
};
$("#saveSettings").onclick = async () => {
  try { await api("/api/settings", { method: "POST", json: { api_key: $("#apiKey").value, cache_limit_mb: +$("#cacheLimit").value } }); toast("Settings saved."); loadSettings(); }
  catch (err) { toast(err.message); }
};
$("#fileInput").onchange = e => uploadFiles(e.target.files);
$("#exportBtn").onclick = () => {
  const data = JSON.stringify(Lib.exportLibrary());
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = `ficshelf-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$("#importInput").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { const n = await Lib.importLibrary(JSON.parse(await f.text())); toast(`Backup restored: ${n} fics added.`); await refreshQuiet(); }
  catch (err) { toast(err.message); }
  e.target.value = "";
};
const drop = $("#drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => uploadFiles(e.dataTransfer.files));
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => { e.preventDefault(); if (!e.target.closest("#drop") && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });

// find in story
const F = { marks: [], i: -1, q: "" };
function clearFind() {
  for (const m of $$("mark.hl", $("#book"))) { const p = m.parentNode; p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); }
  F.marks = []; F.i = -1; F.q = ""; $("#findCount").textContent = "";
}
function runFind(q) {
  clearFind(); F.q = q; if (!q) return;
  const book = $("#book"), needle = q.toLowerCase();
  const walker = document.createTreeWalker(book, NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeValue.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue, low = text.toLowerCase(); const frag = document.createDocumentFragment(); let pos = 0, idx;
    while ((idx = low.indexOf(needle, pos)) !== -1) {
      if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
      const m = document.createElement("mark"); m.className = "hl"; m.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(m); F.marks.push(m); pos = idx + needle.length;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  }
  if (!F.marks.length) { $("#findCount").textContent = "No matches"; return; }
  // start from the first match below the current reading position
  const sc = $("#readerScroll"); F.i = Math.max(0, F.marks.findIndex(m => m.offsetTop >= sc.scrollTop)) - 1;
  stepFind(1);
}
function stepFind(dir) {
  if (!F.marks.length) return;
  F.marks[F.i]?.classList.remove("cur");
  F.i = (F.i + dir + F.marks.length) % F.marks.length;
  const m = F.marks[F.i]; m.classList.add("cur");
  m.scrollIntoView({ block: "center" });
  $("#findCount").textContent = `${F.i + 1} of ${F.marks.length}`;
}
let findT;
$("#findQ").addEventListener("input", e => { clearTimeout(findT); findT = setTimeout(() => { const q = e.target.value.trim(); if (q.length >= 2 || !q) runFind(q); }, 300); });
$("#findForm").onsubmit = e => { e.preventDefault(); const q = $("#findQ").value.trim(); if (q !== F.q) runFind(q); else stepFind(1); };
$("#findQ").addEventListener("keydown", e => { if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); stepFind(-1); } if (e.key === "Escape") { e.stopPropagation(); e.target.value = ""; clearFind(); } });
$("#findPrev").onclick = () => stepFind(-1);
document.addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key === "f" && !$("#reader").hidden && !$("#readerScroll").hidden) { e.preventDefault(); $("#findQ").focus(); $("#findQ").select(); } });

// reader controls
$("#readerBack").onclick = closeReader;
$("#readerScroll").addEventListener("scroll", onReaderScroll, { passive: true });
$("#chapterSel").onchange = e => { const el = $("#ch" + e.target.value); if (el) $("#readerScroll").scrollTop = el.offsetTop - 10; };
$("#widthBtn").onclick = () => { const k = Object.keys(WIDTHS); R.rw = k[(k.indexOf(R.rw) + 1) % k.length]; store.set("rw", R.rw); applyWidth(); };
$("#fontUp").onclick = () => { R.fs = Math.min(28, R.fs + 1); store.set("fs", R.fs); $("#book").style.setProperty("--fs", R.fs + "px"); };
$("#fontDown").onclick = () => { R.fs = Math.max(14, R.fs - 1); store.set("fs", R.fs); $("#book").style.setProperty("--fs", R.fs + "px"); };
$$("#readerTheme button").forEach(b => b.onclick = () => { R.rt = b.dataset.rt; store.set("rt", R.rt); $("#reader").dataset.rt = R.rt; $$("#readerTheme button").forEach(x => x.classList.toggle("on", x === b)); });

new IntersectionObserver(es => { if (es[0].isIntersecting && S.shown < S.filtered.length) renderMore(); }, { rootMargin: "600px" }).observe($("#more"));
applyTheme();
loadAll().then(schedulePoll).catch(e => toast(e.message));
