// ----------------------------------------------------------------------------------------
// Slideshow — a simple presentation maker and presenter, one per placement (sfi_id).
//
// Design axes:
//   privacy:        privacy-public-view  — editors build/edit the deck; viewers and anonymous
//                                           link visitors get a read-only, browseable presentation.
//   data_storage:   storage-simple-files — the whole deck lives in a single show.json under a
//                                           per-sfi folder; uploaded images sit beside it in an
//                                           images/ subfolder. No DB / SyncTable.
//   view_realtime:  view-collaborative   — every save calls pushToInstance so all viewers of the
//                                           placement refresh live.
//   settings_scope: settings-per-sfi     — everything is keyed by peer.sfi_id.
// ----------------------------------------------------------------------------------------
import {
  log, jsonReply, parseJsonBody, parsePeerInfo, pushToInstance,
  frameDataDir, serveFileAtPath, contentType, extname, path,
} from "@frame-core";

// ----- Deck shape -----------------------------------------------------------------------
// The deck is one JSON document. All element geometry (x/y/w/h) and font sizes are stored in
// LOGICAL pixels relative to a fixed slide canvas whose dimensions are derived from the show's
// aspect ratio (see ASPECTS in the frontend). The frontend renders that canvas at any size via
// a single CSS transform: scale(...), so every element stays precisely placed at any zoom.
type Show = { settings: Settings; slides: Slide[] };
type Settings = { palette: string; background: string; aspect: string };
type Slide = { id: string; background: string; elements: SlideElement[] };
type SlideElement = {
  id: string;
  type: "text" | "image" | "shape";
  x: number; y: number; w: number; h: number;
  // text
  text?: string; style?: string; align?: string; color?: string; size?: number; weight?: number;
  // image
  imageId?: string; fit?: string;
  // shape
  shape?: string; fill?: string; radius?: number;
};

const DEFAULT_SHOW: Show = {
  settings: { palette: "c1", background: "paper", aspect: "16:9" },
  slides: [],
};

// Caps — keep disk + rendering bounded.
const MAX_SLIDES = 80;
const MAX_ELEMENTS = 40;
const MAX_TEXT = 4000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const KEEP_RECENT_IMG_MS = 5 * 60 * 1000; // don't GC images uploaded in the last 5 min

// ----- Files on disk --------------------------------------------------------------------
// data/shows/<sfi_slug>/show.json
// data/shows/<sfi_slug>/images/<uuid>.<ext>
const SHOWS_DIR = path.join(frameDataDir(import.meta.url), "shows");

function sfiSlug(sfiId: string): string {
  return (sfiId || "").replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
}
function showDir(sfiId: string): string { return path.join(SHOWS_DIR, sfiSlug(sfiId)); }
function imagesDir(sfiId: string): string { return path.join(showDir(sfiId), "images"); }
function showFile(sfiId: string): string { return path.join(showDir(sfiId), "show.json"); }

const ID_RE = /^[0-9a-fA-F-]{8,64}$/;

function loadShow(sfiId: string): Show {
  try {
    const raw = Deno.readTextFileSync(showFile(sfiId));
    return sanitizeShow(JSON.parse(raw));
  } catch { return structuredClone(DEFAULT_SHOW); }
}
function saveShow(sfiId: string, show: Show): void {
  Deno.mkdirSync(showDir(sfiId), { recursive: true });
  Deno.writeTextFileSync(showFile(sfiId), JSON.stringify(show, null, 2));
}

// ----- Validation -----------------------------------------------------------------------
function num(v: unknown, def: number, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
function str(v: unknown, max: number): string {
  return String(v ?? "").slice(0, max);
}
function oneOf(v: unknown, allowed: string[], def: string): string {
  const s = String(v ?? "");
  return allowed.includes(s) ? s : def;
}

function sanitizeElement(e: any): SlideElement | null {
  if (!e || typeof e !== "object") return null;
  const type = oneOf(e.type, ["text", "image", "shape"], "text") as SlideElement["type"];
  const id = ID_RE.test(String(e.id || "")) ? String(e.id) : crypto.randomUUID();
  const out: SlideElement = {
    id, type,
    x: num(e.x, 0, -2000, 4000), y: num(e.y, 0, -2000, 4000),
    w: num(e.w, 200, 4, 4000), h: num(e.h, 100, 4, 4000),
  };
  if (type === "text") {
    out.text = str(e.text, MAX_TEXT);
    out.style = oneOf(e.style, ["heading", "subheading", "body", "bullets", "caption"], "body");
    out.align = oneOf(e.align, ["left", "center", "right"], "left");
    out.color = oneOf(e.color, ["text", "secondary", "muted", "accent", "accentfg", "white"], "text");
    out.size = num(e.size, 32, 6, 400);
    out.weight = num(e.weight, 400, 300, 800);
  } else if (type === "image") {
    out.imageId = ID_RE.test(String(e.imageId || "")) ? String(e.imageId) : "";
    out.fit = oneOf(e.fit, ["contain", "cover"], "contain");
    out.radius = num(e.radius, 0, 0, 1000);
  } else {
    out.shape = oneOf(e.shape, ["rect", "ellipse", "line"], "rect");
    out.fill = oneOf(e.fill, ["accent", "accentmuted", "text", "muted", "white", "none"], "accent");
    out.radius = num(e.radius, 0, 0, 1000);
  }
  return out;
}

function sanitizeShow(raw: any): Show {
  const s = raw && typeof raw === "object" ? raw : {};
  const settings: Settings = {
    palette: oneOf(s.settings?.palette, ["c1","c2","c3","c4","c5","c6","c7","c8","c9","c10","c11","c12"], "c1"),
    background: oneOf(s.settings?.background, ["paper","white","dark","accent","accentmuted"], "paper"),
    aspect: oneOf(s.settings?.aspect, ["16:9","4:3","1:1"], "16:9"),
  };
  const slidesIn = Array.isArray(s.slides) ? s.slides.slice(0, MAX_SLIDES) : [];
  const slides: Slide[] = slidesIn.map((sl: any) => {
    const id = ID_RE.test(String(sl?.id || "")) ? String(sl.id) : crypto.randomUUID();
    const elsIn = Array.isArray(sl?.elements) ? sl.elements.slice(0, MAX_ELEMENTS) : [];
    const elements = elsIn.map(sanitizeElement).filter(Boolean) as SlideElement[];
    return { id, background: oneOf(sl?.background, ["inherit","paper","white","dark","accent","accentmuted"], "inherit"), elements };
  });
  return { settings, slides };
}

// Remove image files no longer referenced by any element (skip very recent uploads).
function gcImages(sfiId: string, show: Show): void {
  const referenced = new Set<string>();
  for (const sl of show.slides) for (const el of sl.elements) if (el.imageId) referenced.add(el.imageId);
  let entries: Deno.DirEntry[];
  try { entries = [...Deno.readDirSync(imagesDir(sfiId))]; } catch { return; }
  const now = Date.now();
  for (const e of entries) {
    if (!e.isFile) continue;
    const id = e.name.replace(/\.[^.]+$/, "");
    if (referenced.has(id)) continue;
    const full = path.join(imagesDir(sfiId), e.name);
    try {
      const st = Deno.statSync(full);
      if (st.mtime && now - st.mtime.getTime() < KEEP_RECENT_IMG_MS) continue;
      Deno.removeSync(full);
    } catch { /* already gone */ }
  }
}

function imageFile(sfiId: string, id: string): { full: string; name: string } | null {
  if (!ID_RE.test(id)) return null;
  try {
    const kid = [...Deno.readDirSync(imagesDir(sfiId))].find((k) => k.isFile && k.name.replace(/\.[^.]+$/, "") === id);
    if (!kid) return null;
    return { full: path.join(imagesDir(sfiId), kid.name), name: kid.name };
  } catch { return null; }
}

// Light magic-byte sniff so a non-image renamed to .png is rejected server-side.
function looksLikeImage(buf: Uint8Array): boolean {
  if (buf.length < 12) return false;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;              // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                                // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;                                // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&                          // RIFF....WEBP
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true;
  return false;
}

function stateFor(peer: ReturnType<typeof parsePeerInfo>) {
  return {
    me: {
      is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
      user_name: peer.user_name,
    },
    show: loadShow(peer.sfi_id),
  };
}

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  // Static assets — open to everyone (read-only viewers still need the shell).
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Full deck + identity in one round trip. Readable by everyone (public view).
  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, stateFor(peer));
  }

  // Save the whole deck — editors only. Last-write-wins; viewers refresh on the push.
  if (reqPath === "/api/save" && method === "POST") {
    if (!peer.is_sfi_editor) return jsonReply(replyPort, 403, { error: "editors only" });
    const v = parseJsonBody<{ show?: any; by?: string }>(body) || {};
    const show = sanitizeShow(v.show);
    saveShow(peer.sfi_id, show);
    gcImages(peer.sfi_id, show);
    pushToInstance(peer.sfi_id, { type: "deck_changed", by: str(v.by, 64) });
    return jsonReply(replyPort, 200, { ok: true });
  }

  // Image upload — editors only. Bytes are the raw body; ext rides in ?ext=. Client resizes
  // down to <= 2048px and a reasonable byte size before sending; we re-check both here.
  if (reqPath === "/api/upload" && method === "POST") {
    if (!peer.is_sfi_editor) return jsonReply(replyPort, 403, { error: "editors only" });
    let ext = String(query.ext || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ext === "jpeg") ext = "jpg";
    if (!IMG_EXTS.has(ext)) return jsonReply(replyPort, 400, { error: "unsupported image type" });
    if (body.byteLength === 0) return jsonReply(replyPort, 400, { error: "empty upload" });
    if (body.byteLength > MAX_IMAGE_BYTES) return jsonReply(replyPort, 413, { error: "image too large" });
    const bytes = new Uint8Array(body);
    if (!looksLikeImage(bytes)) return jsonReply(replyPort, 415, { error: "file is not an image" });
    const id = crypto.randomUUID();
    Deno.mkdirSync(imagesDir(peer.sfi_id), { recursive: true });
    Deno.writeFileSync(path.join(imagesDir(peer.sfi_id), id + "." + ext), bytes);
    return jsonReply(replyPort, 200, { imageId: id });
  }

  // Image fetch — readable by everyone who can see the deck.
  if (reqPath.startsWith("/api/image/") && method === "GET") {
    const found = imageFile(peer.sfi_id, reqPath.slice("/api/image/".length));
    if (!found) return jsonReply(replyPort, 404, { error: "not found" });
    let buf: Uint8Array;
    try { buf = Deno.readFileSync(found.full); } catch { return jsonReply(replyPort, 404, { error: "not found" }); }
    const mime = contentType(extname(found.name)) || "application/octet-stream";
    return replyPort.postMessage({
      status: 200, body: buf, contentType: mime,
      headers: { "Cache-Control": "private, max-age=300" },
    }, [buf.buffer]);
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Slideshow frame is up and running!");
