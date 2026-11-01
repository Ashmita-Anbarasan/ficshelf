/* FicShelf web — storage, zip reading, Google Drive access and AO3 metadata parsing.
   Everything runs in the visitor's browser. Nothing is sent anywhere except Google's Drive API. */
"use strict";

/* ------------------------------------------------------------ IndexedDB */
const DB = (() => {
  let dbp;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open("ficshelf", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        const it = d.createObjectStore("items", { keyPath: "id", autoIncrement: true });
        it.createIndex("drive_id", "drive_id");
        it.createIndex("source_id", "source_id");
        d.createObjectStore("sources", { keyPath: "id", autoIncrement: true });
        d.createObjectStore("files"); // item id -> Blob
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function store(name, mode = "readonly") { return (await open()).transaction(name, mode).objectStore(name); }
  return {
    async all(name) { return req((await store(name)).getAll()); },
    async get(name, key) { return req((await store(name)).get(key)); },
    async put(name, value, key) { return req(key === undefined ? (await store(name, "readwrite")).put(value) : (await store(name, "readwrite")).put(value, key)); },
    async del(name, key) { return req((await store(name, "readwrite")).delete(key)); },
    async clear(name) { return req((await store(name, "readwrite")).clear()); },
  };
})();

/* ------------------------------------------------------------ errors */
class DriveError extends Error {}
class QuotaError extends DriveError {}

/* ------------------------------------------------------------ zip (random access) */
class Zip {
  // read(start, end) -> Promise<Uint8Array> for bytes [start, end)
  constructor(read, size, entries) { this.read = read; this.size = size; this.entries = entries; }
  static async open(read, size) {
    const tailLen = Math.min(size, 65536 + 22);
    const tail = await read(size - tailLen, size);
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Not a valid EPUB (zip) file");
    const count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
    const tailStart = size - tailLen;
    const cd = cdOff >= tailStart ? tail.subarray(cdOff - tailStart, cdOff - tailStart + cdSize) : await read(cdOff, cdOff + cdSize);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const entries = new Map(); let p = 0; const td = new TextDecoder();
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cv.getUint32(p, true) !== 0x02014b50) break;
      const method = cv.getUint16(p + 10, true), comp = cv.getUint32(p + 20, true);
      const nameLen = cv.getUint16(p + 28, true), extraLen = cv.getUint16(p + 30, true), commLen = cv.getUint16(p + 32, true);
      const off = cv.getUint32(p + 42, true);
      const name = td.decode(cd.subarray(p + 46, p + 46 + nameLen));
      entries.set(name, { method, comp, off, nameLen, extraLen });
      p += 46 + nameLen + extraLen + commLen;
    }
    return new Zip(read, size, entries);
  }
  has(name) { return this.entries.has(name); }
  async bytes(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error("Missing file in EPUB: " + name);
    // read local header + a little slack in one go
    const guess = await this.read(e.off, Math.min(this.size, e.off + 30 + e.nameLen + e.extraLen + 64 + e.comp));
    const hv = new DataView(guess.buffer, guess.byteOffset, guess.byteLength);
    const start = 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    let data = guess.subarray(start, start + e.comp);
    if (data.length < e.comp) data = await this.read(e.off + start, e.off + start + e.comp);
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error("Unsupported compression in EPUB");
    const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  }
  async text(name) { return new TextDecoder().decode(await this.bytes(name)); }
}
function memReader(buf) { const u = new Uint8Array(buf); return async (s, e) => u.subarray(s, e); }

/* ------------------------------------------------------------ Google Drive */
const Drive = (() => {
  const API = "https://www.googleapis.com/drive/v3/files";
  const FOLDER = "application/vnd.google-apps.folder";
  function key() {
    let k = ""; try { k = JSON.parse(localStorage.getItem("ficshelf.apiKey") || '""'); } catch {}
    return (k || (window.FICSHELF_CONFIG && window.FICSHELF_CONFIG.googleApiKey) || "").trim();
  }
  function folderIdFromUrl(url) {
    url = (url || "").trim();
    let m = url.match(/\/folders\/([\w-]{10,})/) || url.match(/[?&]id=([\w-]{10,})/);
    if (m) return m[1];
    if (/^[\w-]{10,}$/.test(url)) return url;
    throw new DriveError("That doesn't look like a Google Drive folder link.");
  }
  async function call(url, params = {}, init = {}) {
    const k = key();
    if (!k) throw new DriveError("This site needs a Google API key before it can read Drive folders (Sources → Settings).");
    const u = new URL(url);
    for (const [a, b] of Object.entries(params)) u.searchParams.set(a, b);
    u.searchParams.set("key", k);
    let r;
    try { r = await fetch(u, init); } catch (e) { throw new DriveError("Couldn't reach Google Drive. Check your internet connection."); }
    if (r.ok) return r;
    let msg = "", reason = "";
    try { const j = await r.json(); msg = j.error?.message || ""; reason = j.error?.errors?.[0]?.reason || ""; } catch {}
    if (/quota|rateLimit|downloadQuota/i.test(reason + " " + msg) || r.status === 429)
      throw new QuotaError("Google's download limit was hit for now. Try again later.");
    if (r.status === 404) throw new DriveError("Not found — the file or folder may be private or deleted.");
    if (/referer|referrer/i.test(msg)) throw new DriveError("The Google API key doesn't allow this website. Add this site's address to the key's allowed websites.");
    if (/API key not valid/i.test(msg)) throw new DriveError("The Google API key isn't valid.");
    throw new DriveError(`Google Drive error ${r.status}${msg ? ": " + msg : ""}`);
  }
  function kindOf(name, mime = "") {
    const n = name.toLowerCase();
    if (n.endsWith("epub") || mime === "application/epub+zip") return "epub";
    if (n.endsWith("pdf") || mime === "application/pdf") return "pdf";
    return null;
  }
  async function list(folderId) {
    const out = []; let token = "";
    do {
      const params = { q: `'${folderId}' in parents and trashed=false`, pageSize: 1000,
        fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,shortcutDetails)",
        supportsAllDrives: "true", includeItemsFromAllDrives: "true" };
      if (token) params.pageToken = token;
      const j = await (await call(API, params)).json();
      for (const f of j.files || []) {
        let id = f.id, mime = f.mimeType;
        if (mime === "application/vnd.google-apps.shortcut" && f.shortcutDetails) { id = f.shortcutDetails.targetId; mime = f.shortcutDetails.targetMimeType; }
        out.push({ id, name: f.name, folder: mime === FOLDER, size: f.size ? +f.size : null, modified: f.modifiedTime || "", mime });
      }
      token = j.nextPageToken || "";
    } while (token);
    return out;
  }
  async function* walk(folderId, path = "", seen = new Set(), onFolder) {
    if (seen.has(folderId)) return;
    seen.add(folderId);
    onFolder && onFolder(path || "/");
    for (const c of await list(folderId)) {
      if (c.folder) yield* walk(c.id, `${path}/${c.name}`, seen, onFolder);
      else { const k = kindOf(c.name, c.mime); if (k) yield { ...c, kind: k, path: path || "/" }; }
    }
  }
  async function folderName(id) {
    const j = await (await call(`${API}/${id}`, { fields: "name,mimeType", supportsAllDrives: "true" })).json();
    if (j.mimeType && j.mimeType !== FOLDER) throw new DriveError("That link is a file, not a folder.");
    return j.name || "Drive folder";
  }
  const media = id => [`${API}/${id}`, { alt: "media", supportsAllDrives: "true" }];
  // Returns a range reader for a Drive file. Falls back to the whole file if ranges aren't honoured.
  async function rangeReader(id, size) {
    const [url, params] = media(id);
    let whole = null;
    if (!size || size <= 256 * 1024) {
      whole = new Uint8Array(await (await call(url, params)).arrayBuffer());
      return { size: whole.length, read: async (s, e) => whole.subarray(s, e) };
    }
    const BLOCK = 64 * 1024, blocks = new Map();
    async function fetchBlocks(b0, b1) {
      const lo = b0 * BLOCK, hi = Math.min(size, (b1 + 1) * BLOCK) - 1;
      let r;
      try { r = await call(url, params, { headers: { Range: `bytes=${lo}-${hi}` } }); }
      catch (e) { if (e instanceof QuotaError) throw e; r = null; }
      if (!r || r.status !== 206) { whole = new Uint8Array(await (await call(url, params)).arrayBuffer()); return; }
      const data = new Uint8Array(await r.arrayBuffer());
      for (let b = b0, i = 0; b <= b1; b++, i++) blocks.set(b, data.subarray(i * BLOCK, (i + 1) * BLOCK));
    }
    async function read(s, e) {
      e = Math.min(e, size); if (e <= s) return new Uint8Array(0);
      if (whole) return whole.subarray(s, e);
      const b0 = Math.floor(s / BLOCK), b1 = Math.floor((e - 1) / BLOCK);
      const missing = []; for (let b = b0; b <= b1; b++) if (!blocks.has(b)) missing.push(b);
      if (missing.length) { await fetchBlocks(missing[0], missing[missing.length - 1]); if (whole) return whole.subarray(s, e); }
      const out = new Uint8Array(e - s);
      for (let b = b0; b <= b1; b++) {
        const blk = blocks.get(b), bs = b * BLOCK;
        const from = Math.max(s, bs), to = Math.min(e, bs + blk.length);
        out.set(blk.subarray(from - bs, to - bs), from - s);
      }
      return out;
    }
    return { size, read };
  }
  async function download(id, onProgress) {
    const [url, params] = media(id);
    const r = await call(url, params);
    const total = +(r.headers.get("Content-Length") || 0);
    if (!r.body) return await r.blob();
    const reader = r.body.getReader(); const chunks = []; let done = 0;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      chunks.push(value); done += value.length; onProgress && onProgress(done, total);
    }
    return new Blob(chunks);
  }
  return { key, folderIdFromUrl, walk, folderName, rangeReader, download, kindOf };
})();

/* ------------------------------------------------------------ metadata parsing */
const Parse = (() => {
  const LIST = { "archive warning": "warnings", "archive warnings": "warnings", "category": "category", "categories": "category",
    "fandom": "fandoms", "fandoms": "fandoms", "relationship": "relationships", "relationships": "relationships",
    "character": "characters", "characters": "characters", "additional tags": "tags", "collections": "collections" };
  const TEXT = { rating: "rating", language: "language", series: "series", stats: "stats" };
  const LABEL_RE = /^\s*(Rating|Archive Warnings?|Categor(?:y|ies)|Fandoms?|Relationships?|Characters?|Additional Tags|Language|Series|Collections|Stats):\s*(.*)$/;
  const WORK_RE = /archiveofourown\.org\/works\/(\d+)/;
  const RATINGS = ["General Audiences", "Teen And Up Audiences", "Mature", "Explicit", "Not Rated"];
  const ta = document.createElement("textarea");
  const decode = s => { ta.innerHTML = s; return ta.value; };
  function empty() {
    return { title: "", author: "", rating: "", warnings: [], category: [], fandoms: [], relationships: [], characters: [], tags: [],
      collections: [], language: "", series: "", summary: "", work_id: "", words: null, chapters: "", complete: null,
      published: "", updated: "", is_ao3: false };
  }
  function stripTags(s) {
    s = (s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p\s*>/gi, "\n\n").replace(/<[^>]+>/g, "");
    s = decode(s).replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n\s*(\n\s*)+/g, "\n\n");
    return s.trim();
  }
  const splitList = s => (s || "").split(/,\s*/).map(x => x.trim()).filter(Boolean);
  function applyStats(m, text) {
    text = (text || "").replace(/\s+/g, " ");
    let r = text.match(/Words:\s*([\d,\.]+)/); if (r) m.words = parseInt(r[1].replace(/[,\.]/g, ""), 10);
    r = text.match(/Chapters:\s*(\d+\s*\/\s*[\d\?]+)/);
    if (r) { const ch = r[1].replace(/\s/g, ""); m.chapters = ch; const [a, b] = ch.split("/"); m.complete = b !== "?" && a === b; }
    r = text.match(/Published:\s*(\d{4}-\d{2}-\d{2})/); if (r) m.published = r[1];
    r = text.match(/(?:Updated|Completed):\s*(\d{4}-\d{2}-\d{2})/); m.updated = r ? r[1] : m.published;
  }
  function setField(m, label, raw, items) {
    const k = label.toLowerCase().trim();
    if (LIST[k]) m[LIST[k]] = items && items.length ? items : splitList(raw);
    else if (TEXT[k]) { if (TEXT[k] === "stats") applyStats(m, raw); else m[TEXT[k]] = raw.replace(/\s+/g, " ").trim(); }
  }
  const resolve = (base, href) => { const parts = (base ? base + "/" + href : href).split("/"); const out = []; for (const p of parts) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); } return out.join("/"); };
  const dirname = p => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const xml = s => new DOMParser().parseFromString(s, "application/xml");
  const byTag = (el, name) => [...el.getElementsByTagNameNS("*", name)];

  async function structure(zip) {
    const container = xml(await zip.text("META-INF/container.xml"));
    const rootfile = byTag(container, "rootfile")[0].getAttribute("full-path");
    const opfDir = dirname(rootfile);
    const opf = xml(await zip.text(rootfile));
    const manifest = new Map(byTag(opf, "item").map(i => [i.getAttribute("id"), i]));
    const spine = byTag(opf, "itemref").map(r => manifest.get(r.getAttribute("idref"))).filter(Boolean)
      .map(i => resolve(opfDir, decodeURIComponent(i.getAttribute("href"))));
    const toc = new Map();
    const ncx = [...manifest.values()].find(i => (i.getAttribute("media-type") || "").includes("ncx"));
    if (ncx) {
      try {
        const ncxPath = resolve(opfDir, ncx.getAttribute("href"));
        const n = xml(await zip.text(ncxPath));
        for (const np of byTag(n, "navPoint")) {
          const label = (byTag(np, "text")[0]?.textContent || "").trim();
          const src = byTag(np, "content")[0]?.getAttribute("src") || "";
          const path = resolve(dirname(ncxPath), decodeURIComponent(src.split("#")[0]));
          if (!toc.has(path)) toc.set(path, label);
        }
      } catch {}
    }
    return { opf, spine, toc };
  }
  function preface(m, doc) {
    const w = doc.match(WORK_RE); if (w) { m.work_id = w[1]; m.is_ao3 = true; }
    for (const [, dt, dd] of doc.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
      const label = stripTags(dt).replace(/:$/, "").trim();
      const anchors = [...dd.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map(a => stripTags(a[1]));
      setField(m, label, stripTags(dd), anchors);
    }
    const by = doc.match(/class="byline"[^>]*>([\s\S]*?)<\/div>/);
    if (by) { const a = [...by[1].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map(x => stripTags(x[1])); m.author = a.join(", ") || stripTags(by[1]).replace(/^by /, ""); }
    const sm = doc.match(/>\s*Summary\s*<\/p>\s*<blockquote[^>]*>([\s\S]*?)<\/blockquote>/);
    if (sm) m.summary = stripTags(sm[1]);
  }
  async function epub(zip, filename = "") {
    const m = empty();
    const { opf, spine } = await structure(zip);
    const md = byTag(opf, "metadata")[0];
    if (md) {
      const first = t => (byTag(md, t)[0]?.textContent || "").trim();
      m.title = first("title");
      m.author = byTag(md, "creator").map(c => c.textContent.trim()).filter(Boolean).join(", ");
      m.summary = stripTags(first("description"));
      m.published = first("date").slice(0, 10);
      const subjects = byTag(md, "subject").map(s => s.textContent.trim());
      for (const r of RATINGS) if (subjects.includes(r)) m.rating = r;
      m.tags = subjects.filter(s => s && s !== "Fanworks");
    }
    for (const href of spine.slice(0, 3)) {
      if (!zip.has(href)) continue;
      const doc = await zip.text(href);
      if (doc.includes("<dl") || doc.includes("byline") || doc.includes("Summary")) preface(m, doc);
    }
    if (!m.title) m.title = filename.replace(/\.(epub|pdf)$/i, "").replace(/_/g, " ");
    return m;
  }
  // pdf.js text items -> lines [{y, x0, text, gapBefore}]
  function lines(items) {
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5];
      let row = rows.find(r => Math.abs(r.y - y) < 2.5);
      if (!row) { row = { y, parts: [] }; rows.push(row); }
      row.parts.push({ x, s: it.str, w: it.width || 0 });
    }
    rows.sort((a, b) => b.y - a.y);
    const out = [];
    const gaps = rows.slice(1).map((r, i) => rows[i].y - r.y).filter(g => g > 0).sort((a, b) => a - b);
    const typical = gaps.length ? gaps[Math.floor(gaps.length / 3)] : 12;
    rows.forEach((r, i) => {
      r.parts.sort((a, b) => a.x - b.x);
      let text = "", lastEnd = null;
      for (const p of r.parts) { if (lastEnd !== null && p.x - lastEnd > 1.5) text += " "; text += p.s; lastEnd = p.x + p.w; }
      out.push({ y: r.y, x0: r.parts[0].x, parts: r.parts, text: text.replace(/\s+/g, " ").trim(),
        gapBefore: i > 0 && rows[i - 1].y - r.y > typical * 1.6 });
    });
    return out;
  }
  async function pdf(data, filename = "") {
    const m = empty();
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    let info = {}; try { info = (await doc.getMetadata()).info || {}; } catch {}
    let L = [];
    for (let p = 1; p <= Math.min(2, doc.numPages); p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      const ls = lines(tc.items); if (ls.length && L.length) ls[0].gapBefore = true;
      L = L.concat(ls);
    }
    doc.destroy();
    const all = L.map(l => l.text).join("\n");
    const w = all.match(WORK_RE); if (w) { m.work_id = w[1]; m.is_ao3 = true; }
    // label / value block
    let cur = null, val = [], labelX = 0, statsSeen = false;
    const flush = () => { if (cur) { setField(m, cur, val.join(" ")); if (cur === "Stats") statsSeen = true; } cur = null; val = []; };
    for (const l of L) {
      const lm = l.text.match(LABEL_RE);
      if (lm && (!statsSeen || cur)) { flush(); cur = lm[1]; val = [lm[2]]; labelX = l.x0; continue; }
      if (cur && !l.gapBefore && l.x0 > labelX + 20) { val.push(l.text); continue; }
      if (cur) flush();
    }
    flush();
    m.title = (info.Title || "").trim() || (L[0] ? L[0].text : "");
    const byLine = L.find((l, i) => i > 0 && /^by .+/.test(l.text));
    m.author = byLine ? byLine.text.slice(3).trim() : (info.Author || "").trim();
    const si = L.findIndex(l => l.text === "Summary");
    if (si >= 0) {
      const paras = []; let curP = [];
      for (const l of L.slice(si + 1)) {
        if (/^(Notes|See the end of the work|Chapter \d+|Chapter Text)\b/.test(l.text)) break;
        if (l.gapBefore && curP.length) { paras.push(curP.join(" ")); curP = []; }
        curP.push(l.text);
      }
      if (curP.length) paras.push(curP.join(" "));
      m.summary = paras.join("\n\n");
    }
    if (!m.tags.length && info.Keywords) m.tags = splitList(info.Keywords).filter(t => t !== "Fanworks");
    if (!m.title) m.title = filename.replace(/\.(epub|pdf)$/i, "").replace(/_/g, " ");
    return m;
  }
  // Chapters for the reader, sanitised, with images as blob URLs
  async function book(zip) {
    const { spine, toc } = await structure(zip);
    const out = [];
    for (let i = 0; i < spine.length; i++) {
      const href = spine[i]; if (!zip.has(href)) continue;
      const doc = new DOMParser().parseFromString(await zip.text(href), "text/html");
      doc.querySelectorAll("script,style,iframe,object,embed,link,meta,form,input,button").forEach(n => n.remove());
      for (const el of doc.body.querySelectorAll("*")) {
        for (const a of [...el.attributes]) if (/^on/i.test(a.name) || ["class", "style", "id"].includes(a.name)) el.removeAttribute(a.name);
        if (el.tagName === "A") { const h = el.getAttribute("href") || ""; if (/^https?:/i.test(h)) { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener"); } else el.removeAttribute("href"); }
      }
      for (const img of doc.body.querySelectorAll("img, image")) {
        const attr = img.hasAttribute("src") ? "src" : "xlink:href";
        const src = img.getAttribute(attr) || img.getAttribute("href");
        if (!src || /^(https?:|data:)/.test(src)) continue;
        try {
          const path = resolve(dirname(href), decodeURIComponent(src));
          const blob = new Blob([await zip.bytes(path)]);
          img.setAttribute(attr === "xlink:href" ? "href" : "src", URL.createObjectURL(blob));
        } catch { img.remove(); }
      }
      out.push({ title: toc.get(href) || (i === 0 ? "Preface" : i === 1 ? "Summary & Notes" : `Part ${i + 1}`), html: doc.body.innerHTML });
    }
    return out;
  }
  return { epub, pdf, book };
})();
