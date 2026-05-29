// ----------------------------------------------------------------------------------------
// Community Home — simple public-facing landing page that members of a space can edit.
//
// Auth model:
//   - Anonymous request (peer.is_anon OR user_id is empty) — sees the published page only.
//   - Known user of the space — sees an admin builder UI (title, accent, sections, links)
//     with a "preview" toggle that renders the same public view.
//
// All content is scoped by `sfi_id` so the same frame can be placed multiple times in one
// space (or across many spaces) and each placement owns its own content. Realtime edits
// are fanned out to every live viewer of the placement via pushToInstance(sfi_id, …).
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, serveHtmlShell, pushToInstance, parsePeerInfo, DatabaseSync, path,
  frameDataDir, parseJsonBody,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// DATABASE — every row scoped by sfi_id (per-placement), not by space_id.
// ----------------------------------------------------------------------------------------
const db = new DatabaseSync(path.join(frameDataDir(import.meta.url), "community_home.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS pages (
    sfi_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    tagline TEXT NOT NULL DEFAULT '',
    accent TEXT NOT NULL DEFAULT 'c1',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sfi_id TEXT NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'text',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sections_sfi ON sections(sfi_id, sort_order);

  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sfi_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_links_sfi ON links(sfi_id, sort_order);

  -- Unified page-content table. Lets admins mix sections, links, and pub_frame embeds
  -- in any order. The per-kind columns stay empty for kinds that don't use them.
  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sfi_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'text',
    label TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL DEFAULT 320,
    height INTEGER NOT NULL DEFAULT 320,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_sfi ON blocks(sfi_id, sort_order);
`);

// Back-fill: if a placement was created before sections.format existed, add the column.
try { db.exec("ALTER TABLE sections ADD COLUMN format TEXT NOT NULL DEFAULT 'text'"); } catch { /* already present */ }
// Back-fill pub_frame dimensions for placements created before width/height existed.
try { db.exec("ALTER TABLE blocks ADD COLUMN width INTEGER NOT NULL DEFAULT 320"); } catch { /* already present */ }
try { db.exec("ALTER TABLE blocks ADD COLUMN height INTEGER NOT NULL DEFAULT 320"); } catch { /* already present */ }

// One-time migration: move any existing sections + links (from the pre-blocks schema) into
// the unified blocks table, preserving per-placement ordering (sections first, then links).
const pagesToMigrate = db.prepare(
  "SELECT p.sfi_id FROM pages p WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.sfi_id = p.sfi_id)"
).all() as Array<{ sfi_id: string }>;
for (const { sfi_id } of pagesToMigrate) {
  const secs = db.prepare(
    "SELECT heading, body, format FROM sections WHERE sfi_id = ? ORDER BY sort_order, id"
  ).all(sfi_id) as any[];
  const lnks = db.prepare(
    "SELECT label, url FROM links WHERE sfi_id = ? ORDER BY sort_order, id"
  ).all(sfi_id) as any[];
  let order = 0;
  const insertSec = db.prepare(
    "INSERT INTO blocks (sfi_id, kind, heading, body, format, sort_order) VALUES (?, 'section', ?, ?, ?, ?)"
  );
  const insertLink = db.prepare(
    "INSERT INTO blocks (sfi_id, kind, label, url, sort_order) VALUES (?, 'link', ?, ?, ?)"
  );
  for (const s of secs) insertSec.run(sfi_id, s.heading, s.body, s.format ?? "text", order++);
  for (const l of lnks) insertLink.run(sfi_id, l.label, l.url, order++);
}

// ----------------------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------------------
const VALID_ACCENTS = new Set(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);
const VALID_FORMATS = new Set(["text", "html"]);
const VALID_KINDS = new Set(["section", "link", "pub_frame"]);

// Reject javascript:/data:/file: URLs so pub_frame iframe srcs can't run scripts in the parent context.
function isSafeUrl(u: string): boolean {
  return /^https?:\/\//i.test(u.trim());
}
const MAX_TITLE = 200;
const MAX_TAGLINE = 400;
const MAX_HEADING = 200;
const MAX_BODY = 10_000;
const MAX_LABEL = 120;
const MAX_URL = 2048;
const MIN_DIM = 80;
const MAX_DIM = 2000;

function clampDim(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(n)));
}

function clampStr(v: unknown, max: number): string {
  const s = typeof v === "string" ? v : String(v ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

function ensurePage(sfiId: string): void {
  if (!sfiId) return;
  const existing = db.prepare("SELECT sfi_id FROM pages WHERE sfi_id = ?").get(sfiId);
  if (existing) return;
  db.prepare(
    "INSERT INTO pages (sfi_id, title, tagline, accent, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(sfiId, "Welcome to our community", "A place for updates, links, and news.", "c1", Date.now());
  db.prepare(
    "INSERT INTO blocks (sfi_id, kind, heading, body, format, sort_order) VALUES (?, 'section', ?, ?, 'text', 0)"
  ).run(sfiId, "About us", "Tell visitors what your community is about. Use the edit panel on the left to change this text, update the title, pick an accent color, and add sections, links, or public-frame embeds in any order.");
}

function getPage(sfiId: string) {
  const page = db.prepare("SELECT * FROM pages WHERE sfi_id = ?").get(sfiId) as any;
  const blocks = db.prepare(
    "SELECT id, kind, heading, body, format, label, url, width, height, sort_order FROM blocks WHERE sfi_id = ? ORDER BY sort_order, id"
  ).all(sfiId);
  return {
    title: page?.title ?? "",
    tagline: page?.tagline ?? "",
    accent: page?.accent ?? "c1",
    updated_at: page?.updated_at ?? 0,
    blocks,
  };
}

function broadcast(sfiId: string): void {
  pushToInstance(sfiId, { type: "ch_page_updated", sfi_id: sfiId, page: getPage(sfiId) });
}

// ----------------------------------------------------------------------------------------
// NETWORKING
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, body, cookies) {
  const send = (data: unknown, status = 200) => replyPort.postMessage({
    status, contentType: "application/json", body: JSON.stringify(data),
  });
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;
  const anon = peer.is_anon || !peer.user_id;

  // ----- index.html: serve a single bundled response (html + inlined css + per-viewer
  // window.__peer stamp) so the UI can render without an extra /api/whoami round-trip.
  // The script is inline in index.html as <script type="module"> so it can import
  // /lib/js/framelib.js — inlineJs would flatten that to a non-module <script>, which
  // can't use ES module imports, so it's intentionally omitted here.
  if (reqPath === "/index.html" && method === "GET") {
    return serveHtmlShell(replyPort, new URL("./public/index.html", import.meta.url), {
      peer,
      inlineCss: ["index.css"],
    });
  }

  // ----- public: fetch current page content (both anon and admin share this).
  if (reqPath === "/api/page" && method === "GET") {
    if (!sfiId) return send({ title: "", tagline: "", accent: "c1", blocks: [] });
    ensurePage(sfiId);
    return send(getPage(sfiId));
  }

  // ----- admin routes — require a known user and sfi_id.
  if (reqPath.startsWith("/api/admin/")) {
    if (anon) return send({ error: "forbidden" }, 403);
    if (!sfiId) return send({ error: "sfi_id missing" }, 400);
    ensurePage(sfiId);

    // Update top-level page settings (title / tagline / accent).
    if (reqPath === "/api/admin/page" && method === "PUT") {
      const data = parseJsonBody(body);
      if (!data) return send({ error: "invalid body" }, 400);
      if (typeof data.title === "string") {
        db.prepare("UPDATE pages SET title = ?, updated_at = ? WHERE sfi_id = ?")
          .run(clampStr(data.title, MAX_TITLE), Date.now(), sfiId);
      }
      if (typeof data.tagline === "string") {
        db.prepare("UPDATE pages SET tagline = ?, updated_at = ? WHERE sfi_id = ?")
          .run(clampStr(data.tagline, MAX_TAGLINE), Date.now(), sfiId);
      }
      if (typeof data.accent === "string") {
        if (!VALID_ACCENTS.has(data.accent)) return send({ error: "invalid accent" }, 400);
        db.prepare("UPDATE pages SET accent = ?, updated_at = ? WHERE sfi_id = ?")
          .run(data.accent, Date.now(), sfiId);
      }
      broadcast(sfiId);
      return send({ ok: true });
    }

    // Create a new block. Body: { kind: "section" | "link" | "pub_frame", ...fields }.
    // Always appended to the end — UI positions the add buttons below the last block.
    if (reqPath === "/api/admin/blocks" && method === "POST") {
      const data = parseJsonBody(body);
      const kind = typeof data?.kind === "string" ? data.kind : "";
      if (!VALID_KINDS.has(kind)) return send({ error: "invalid kind" }, 400);

      const maxOrder = db.prepare(
        "SELECT COALESCE(MAX(sort_order), -1) AS m FROM blocks WHERE sfi_id = ?"
      ).get(sfiId) as any;
      const order = (maxOrder?.m ?? -1) + 1;

      if (kind === "section") {
        const heading = clampStr(data.heading, MAX_HEADING);
        const bodyText = clampStr(data.body, MAX_BODY);
        const format = typeof data.format === "string" && VALID_FORMATS.has(data.format) ? data.format : "text";
        db.prepare(
          "INSERT INTO blocks (sfi_id, kind, heading, body, format, sort_order) VALUES (?, 'section', ?, ?, ?, ?)"
        ).run(sfiId, heading, bodyText, format, order);
      } else if (kind === "link") {
        const label = clampStr(data.label, MAX_LABEL);
        const url = clampStr(data.url, MAX_URL).trim();
        if (!label) return send({ error: "label required" }, 400);
        if (!url || !isSafeUrl(url)) return send({ error: "valid http(s) url required" }, 400);
        db.prepare(
          "INSERT INTO blocks (sfi_id, kind, label, url, sort_order) VALUES (?, 'link', ?, ?, ?)"
        ).run(sfiId, label, url, order);
      } else if (kind === "pub_frame") {
        const url = clampStr(data.url, MAX_URL).trim();
        if (!url || !isSafeUrl(url)) return send({ error: "valid http(s) url required" }, 400);
        // heading is reused as an optional title displayed above the iframe.
        const heading = clampStr(data.heading, MAX_HEADING);
        const width = clampDim(data.width, 320);
        const height = clampDim(data.height, 320);
        db.prepare(
          "INSERT INTO blocks (sfi_id, kind, heading, url, width, height, sort_order) VALUES (?, 'pub_frame', ?, ?, ?, ?, ?)"
        ).run(sfiId, heading, url, width, height, order);
      }

      db.prepare("UPDATE pages SET updated_at = ? WHERE sfi_id = ?").run(Date.now(), sfiId);
      broadcast(sfiId);
      return send({ ok: true });
    }

    // Update any block. Only fields present in the patch are touched; kind is immutable.
    const blockMatch = reqPath.match(/^\/api\/admin\/blocks\/(\d+)$/);
    if (blockMatch && method === "PUT") {
      const id = parseInt(blockMatch[1]);
      const owned = db.prepare("SELECT id FROM blocks WHERE id = ? AND sfi_id = ?").get(id, sfiId);
      if (!owned) return send({ error: "not found" }, 404);
      const data = parseJsonBody(body);
      if (!data) return send({ error: "invalid body" }, 400);

      if (typeof data.heading === "string") {
        db.prepare("UPDATE blocks SET heading = ? WHERE id = ?").run(clampStr(data.heading, MAX_HEADING), id);
      }
      if (typeof data.body === "string") {
        db.prepare("UPDATE blocks SET body = ? WHERE id = ?").run(clampStr(data.body, MAX_BODY), id);
      }
      if (typeof data.format === "string") {
        if (!VALID_FORMATS.has(data.format)) return send({ error: "invalid format" }, 400);
        db.prepare("UPDATE blocks SET format = ? WHERE id = ?").run(data.format, id);
      }
      if (typeof data.label === "string") {
        db.prepare("UPDATE blocks SET label = ? WHERE id = ?").run(clampStr(data.label, MAX_LABEL), id);
      }
      if (typeof data.url === "string") {
        const url = clampStr(data.url, MAX_URL).trim();
        if (url && !isSafeUrl(url)) return send({ error: "invalid url" }, 400);
        db.prepare("UPDATE blocks SET url = ? WHERE id = ?").run(url, id);
      }
      // pub_frame dimensions — only meaningful for that kind, but harmless to store otherwise.
      if (data.width !== undefined) {
        db.prepare("UPDATE blocks SET width = ? WHERE id = ?").run(clampDim(data.width, 320), id);
      }
      if (data.height !== undefined) {
        db.prepare("UPDATE blocks SET height = ? WHERE id = ?").run(clampDim(data.height, 320), id);
      }
      db.prepare("UPDATE pages SET updated_at = ? WHERE sfi_id = ?").run(Date.now(), sfiId);
      broadcast(sfiId);
      return send({ ok: true });
    }

    if (blockMatch && method === "DELETE") {
      const id = parseInt(blockMatch[1]);
      const info = db.prepare("DELETE FROM blocks WHERE id = ? AND sfi_id = ?").run(id, sfiId);
      if ((info as any).changes === 0) return send({ error: "not found" }, 404);
      db.prepare("UPDATE pages SET updated_at = ? WHERE sfi_id = ?").run(Date.now(), sfiId);
      broadcast(sfiId);
      return send({ ok: true });
    }

    // Reorder blocks: body = { order: [id, id, id] }
    if (reqPath === "/api/admin/blocks/reorder" && method === "PUT") {
      const data = parseJsonBody(body);
      if (!Array.isArray(data?.order)) return send({ error: "order[] required" }, 400);
      const stmt = db.prepare("UPDATE blocks SET sort_order = ? WHERE id = ? AND sfi_id = ?");
      for (let i = 0; i < data.order.length; i++) stmt.run(i, Number(data.order[i]), sfiId);
      broadcast(sfiId);
      return send({ ok: true });
    }

    return send({ error: "unknown admin route" }, 404);
  }

  // ----- static file fallback.
  if (method === "GET") {
    serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  } else {
    replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
  }
};

log("Community Home frame is up and running!");
