/* FicShelf web — library logic. Provides api(path, opts) with the same routes the
   desktop server had, so the UI code is shared. */
"use strict";

const Lib = (() => {
  const items = new Map();   // id -> item
  const sources = new Map(); // id -> source
  const scans = new Map();   // source id -> { stop: bool, running: Promise }
  const downloads = new Map(); // item id -> {done,total}
  let ready = null;

  const META = ["title", "author", "rating", "warnings", "category", "fandoms", "relationships", "characters", "tags",
    "collections", "language", "series", "summary", "work_id", "words", "chapters", "complete", "published", "updated"];
  const now = () => Date.now() / 1000;
  const setting = (k, d) => { try { const v = localStorage.getItem("ficshelf." + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const setSetting = (k, v) => { try { localStorage.setItem("ficshelf." + k, JSON.stringify(v)); } catch {} };

  async function init() {
    if (!ready) ready = (async () => {
      for (const it of await DB.all("items")) items.set(it.id, it);
      for (const s of await DB.all("sources")) { if (s.status === "scanning") { s.status = "idle"; s.message = "Paused. Press Continue scan to pick up where it stopped."; } sources.set(s.id, s); }
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
    })();
    return ready;
  }
  async function saveItem(it) { const id = await DB.put("items", it); it.id = id; items.set(id, it); return it; }
  async function saveSource(s) { const id = await DB.put("sources", s); s.id = id; sources.set(id, s); return s; }
  function view(it) {
    const { cached, ...rest } = it;
    return { ...rest, downloaded: !!it.cached };
  }
  function sourceView(s) {
    const counts = {};
    for (const it of items.values()) if (it.source_id === s.id) counts[it.status] = (counts[it.status] || 0) + 1;
    return { ...s, counts };
  }

  /* ---------------- scanning */
  async function addSource(url) {
    const fid = Drive.folderIdFromUrl(url);
    for (const s of sources.values()) if (s.folder_id === fid) { startScan(s.id); return s.id; }
    const name = await Drive.folderName(fid);
    const s = await saveSource({ folder_id: fid, url, name, added_at: now(), last_scan: null, status: "idle", message: "", found: 0, done: 0, failed: 0 });
    startScan(s.id);
    return s.id;
  }
  function startScan(sid, retry = false) {
    if (scans.get(sid)?.running) return;
    const st = { stop: false, running: null };
    scans.set(sid, st);
    st.running = scan(sid, retry, st).finally(() => { st.running = null; });
  }
  async function scan(sid, retry, st) {
    const s = sources.get(sid);
    s.status = "scanning"; s.message = "Listing folders…"; s.found = 0; await saveSource(s);
    try {
      const byDrive = new Map([...items.values()].filter(i => i.drive_id).map(i => [i.drive_id, i]));
      let found = 0;
      for await (const f of Drive.walk(s.folder_id, "", new Set(), p => { s.message = `Listing ${p}`; })) {
        if (st.stop) break;
        found++; s.found = found;
        const ex = byDrive.get(f.id);
        if (ex) { ex.filename = f.name; ex.folder = f.path; ex.size = f.size || ex.size; ex.source_id = ex.source_id ?? sid; await saveItem(ex); }
        else { const it = await saveItem({ source_id: sid, drive_id: f.id, filename: f.name, folder: f.path, kind: f.kind, size: f.size,
          modified: f.modified, status: "pending", error: "", title: f.name, author: "", added_at: now(), cached: false,
          cached_size: 0, pinned: false, favorite: false, shelf: "", last_opened: 0, progress: 0 }); byDrive.set(f.id, it); }
      }
      if (retry) for (const it of items.values()) if (it.source_id === sid && it.status === "error") { it.status = "pending"; await saveItem(it); }
      const pending = [...items.values()].filter(i => i.source_id === sid && i.status === "pending").map(i => i.id);
      s.done = 0; s.failed = 0; s.message = `Reading details of ${pending.length} files…`; await saveSource(s);
      let quota = false, idx = 0;
      async function worker() {
        while (idx < pending.length && !st.stop && !quota) {
          const id = pending[idx++];
          const r = await extract(id);
          if (r === true) s.done++; else s.failed++;
          if (r === "quota") quota = true;
          if ((s.done + s.failed) % 10 === 0) await saveSource(s);
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
      s.message = st.stop ? "Paused. Fics read so far are in your library. Press Continue scan to pick up where it stopped."
        : quota ? "Paused: Google's download limit was reached. Try Continue scan again later." : "Up to date";
      s.status = "idle"; s.last_scan = now();
    } catch (e) {
      console.error(e); s.status = "error"; s.message = e.message;
    }
    if (sources.has(sid)) await saveSource(s);
  }
  async function extract(id, force = false) {
    const it = items.get(id); if (!it) return false;
    try {
      let meta;
      if (it.cached) {
        const blob = await DB.get("files", id);
        const buf = await blob.arrayBuffer();
        meta = it.kind === "epub" ? await Parse.epub(await Zip.open(memReader(buf), buf.byteLength), it.filename) : await Parse.pdf(new Uint8Array(buf), it.filename);
      } else if (it.kind === "epub") {
        const rr = await Drive.rangeReader(it.drive_id, it.size);
        if (!it.size) it.size = rr.size;
        meta = await Parse.epub(await Zip.open(rr.read, rr.size), it.filename);
      } else {
        const blob = await Drive.download(it.drive_id);
        if (!it.size) it.size = blob.size;
        meta = await Parse.pdf(new Uint8Array(await blob.arrayBuffer()), it.filename);
      }
      for (const k of META) it[k] = meta[k];
      if (!it.title) it.title = it.filename;
      it.status = "ok"; it.error = "";
      await saveItem(it);
      return true;
    } catch (e) {
      it.status = "error"; it.error = e.message || String(e); await saveItem(it);
      return e instanceof QuotaError ? "quota" : false;
    }
  }

  /* ---------------- reading cache */
  async function ensureDownloaded(id) {
    const it = items.get(id);
    if (it.cached) { const b = await DB.get("files", id); if (b) return b; }
    if (!it.drive_id) throw new DriveError("This imported file is missing from this browser's storage.");
    const st = { done: 0, total: it.size || 0 }; downloads.set(id, st);
    try {
      const blob = await Drive.download(it.drive_id, (d, t) => { st.done = d; st.total = t || st.total; });
      await DB.put("files", blob, id);
      it.cached = true; it.cached_size = blob.size; await saveItem(it);
      if (it.status !== "ok") await extract(id);
      await enforceLimit(id);
      return blob;
    } finally { downloads.delete(id); }
  }
  async function removeDownload(id) {
    const it = items.get(id);
    if (!it.drive_id) throw new Error("Imported files only live in this browser — delete the fic instead.");
    await DB.del("files", id); it.cached = false; it.cached_size = 0; it.pinned = false; await saveItem(it);
  }
  async function deleteItem(id) { await DB.del("files", id); await DB.del("items", id); items.delete(id); }
  function cacheStats() {
    let files = 0, bytes = 0; for (const it of items.values()) if (it.cached) { files++; bytes += it.cached_size || 0; }
    return { files, bytes, limit_mb: setting("cacheLimitMb", 2048) };
  }
  async function enforceLimit(keep) {
    const limit = setting("cacheLimitMb", 2048) * 1048576; if (!limit) return;
    let total = cacheStats().bytes; if (total <= limit) return;
    const cand = [...items.values()].filter(i => i.cached && !i.pinned && i.drive_id && i.id !== keep).sort((a, b) => (a.last_opened || 0) - (b.last_opened || 0));
    for (const it of cand) { if (total <= limit) break; total -= it.cached_size || 0; await removeDownload(it.id); }
  }

  /* ---------------- local import */
  async function importFile(file) {
    const kind = Drive.kindOf(file.name);
    if (!kind) throw new Error("Only .epub and .pdf files are supported");
    const it = await saveItem({ source_id: null, drive_id: null, filename: file.name, folder: "Imported", kind, size: file.size, status: "pending",
      error: "", title: file.name, author: "", added_at: now(), cached: true, cached_size: file.size, pinned: true, favorite: false, shelf: "", last_opened: 0, progress: 0 });
    await DB.put("files", file.slice(0, file.size, file.type), it.id);
    await extract(it.id);
    return it.id;
  }

  /* ---------------- backup */
  function exportLibrary() {
    const strip = ({ cached, cached_size, ...r }) => r;
    return { app: "FicShelf", version: 1, exported_at: new Date().toISOString(),
      sources: [...sources.values()].map(s => ({ ...s, status: "idle" })), items: [...items.values()].filter(i => i.drive_id).map(strip) };
  }
  async function importLibrary(data) {
    if (!data || data.app !== "FicShelf") throw new Error("That isn't a FicShelf backup file.");
    const idMap = new Map();
    for (const s of data.sources || []) {
      const ex = [...sources.values()].find(x => x.folder_id === s.folder_id);
      if (ex) idMap.set(s.id, ex.id); else { const { id, ...r } = s; idMap.set(s.id, (await saveSource(r)).id); }
    }
    const have = new Map([...items.values()].filter(i => i.drive_id).map(i => [i.drive_id, i]));
    let added = 0;
    for (const it of data.items || []) {
      const ex = have.get(it.drive_id);
      if (ex) { for (const k of ["favorite", "shelf", "progress", "last_opened"]) if (it[k]) ex[k] = it[k]; await saveItem(ex); continue; }
      const { id, ...r } = it; r.source_id = idMap.get(it.source_id) ?? null; r.cached = false; r.cached_size = 0;
      await saveItem(r); added++;
    }
    return added;
  }

  /* ---------------- router (same routes as the desktop server) */
  async function route(path, opts = {}) {
    await init();
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.json;
    const u = new URL(path, location.href); const p = u.pathname.replace(/^.*\/api\//, "/api/"); const q = u.searchParams;
    let m;
    if (p === "/api/items" && method === "GET") return [...items.values()].map(view);
    if ((m = p.match(/^\/api\/items\/(\d+)$/))) {
      const id = +m[1], it = items.get(id); if (!it) throw new Error("Not found");
      if (method === "GET") return view(it);
      if (method === "PATCH") {
        if ("pinned" in body) it.pinned = !!body.pinned;
        if ("favorite" in body) it.favorite = !!body.favorite;
        if ("shelf" in body) it.shelf = String(body.shelf);
        if ("progress" in body) it.progress = +body.progress;
        await saveItem(it); return view(it);
      }
      if (method === "DELETE") { await deleteItem(id); return { ok: true }; }
    }
    if ((m = p.match(/^\/api\/items\/(\d+)\/(download|download-progress|rescan|book)$/))) {
      const id = +m[1], act = m[2], it = items.get(id);
      if (act === "download-progress") return downloads.get(id) || {};
      if (act === "download" && method === "POST") { await ensureDownloaded(id); return view(it); }
      if (act === "download" && method === "DELETE") { await removeDownload(id); return view(it); }
      if (act === "rescan") { await extract(id); return view(it); }
      if (act === "book") {
        const blob = await ensureDownloaded(id);
        it.last_opened = now(); await saveItem(it);
        const buf = await blob.arrayBuffer();
        if (it.kind === "pdf") return { kind: "pdf", data: new Uint8Array(buf) };
        return { kind: "epub", chapters: await Parse.book(await Zip.open(memReader(buf), buf.byteLength)) };
      }
    }
    if (p === "/api/sources" && method === "GET") return [...sources.values()].map(sourceView);
    if (p === "/api/sources" && method === "POST") return { id: await addSource(body.url) };
    if ((m = p.match(/^\/api\/sources\/(\d+)(?:\/(sync|pause))?$/))) {
      const sid = +m[1];
      if (m[2] === "sync") { startScan(sid, q.get("retry") === "1"); return { ok: true }; }
      if (m[2] === "pause") { const st = scans.get(sid); if (st) st.stop = true; return { ok: true }; }
      if (method === "DELETE") {
        const st = scans.get(sid); if (st) { st.stop = true; if (st.running) await st.running; }
        const keep = q.get("keep_downloads") === "1";
        for (const it of [...items.values()]) if (it.source_id === sid) {
          if (keep && it.cached) { it.source_id = null; await saveItem(it); } else await deleteItem(it.id);
        }
        await DB.del("sources", sid); sources.delete(sid); return { ok: true };
      }
    }
    if (p === "/api/upload") {
      const added = [], errors = [];
      for (const f of body.getAll("files")) { try { added.push(await importFile(f)); } catch (e) { errors.push(`${f.name}: ${e.message}`); } }
      return { added, errors };
    }
    if (p === "/api/settings") {
      if (method === "POST") {
        if ("api_key" in body) setSetting("apiKey", body.api_key.trim());
        if ("cache_limit_mb" in body) { setSetting("cacheLimitMb", +body.cache_limit_mb); await enforceLimit(); }
      }
      let est = null; try { est = await navigator.storage.estimate(); } catch {}
      return { api_key: setting("apiKey", ""), has_builtin_key: !!(window.FICSHELF_CONFIG && window.FICSHELF_CONFIG.googleApiKey),
        cache: cacheStats(), storage: est };
    }
    throw new Error("Unknown request " + path);
  }
  return { route, init, exportLibrary, importLibrary };
})();

// Same signature the UI already uses.
async function api(path, opts = {}) {
  const o = { ...opts };
  if (o.body instanceof FormData) o.json = o.body;
  return Lib.route(path, o);
}
