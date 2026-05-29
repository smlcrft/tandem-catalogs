// ----------------------------------------------------------------------------------------
// Help Desk — anonymous visitors submit a message (+ email + admin-configured fields);
// known users of the space see a realtime inbox with status + correspondence notes.
//
// Auth model:
//   - Anonymous request: peer.is_anon OR user_id is empty. Sees the submit form.
//   - Known user (admin): !peer.is_anon AND user_id is set. Sees the placement's inbox.
//     All data is scoped by `sfi_id` (the space_frame_instance_id), so the same space can host
//     multiple independent help desk placements and each has its own inbox/fields.
//
// Realtime: submissions, status changes, notes, and field-config edits are pushed to every
// live viewer of this placement via pushToInstance(sfi_id, …); framecore handles viewer
// cap_token tracking automatically based on authenticated requests.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, serveHtmlShell, pushToInstance, parsePeerInfo, DatabaseSync, path,
  frameDataDir, parseJsonBody,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// DATABASE — all rows scoped by sfi_id (per-placement), not by space_id.
// ----------------------------------------------------------------------------------------
const db = new DatabaseSync(path.join(frameDataDir(import.meta.url), "helpdesk.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sfi_id TEXT NOT NULL,
    submitted_at INTEGER NOT NULL,
    email TEXT NOT NULL,
    fields_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'new'
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_sfi ON submissions(sfi_id, submitted_at DESC);

  CREATE TABLE IF NOT EXISTS field_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sfi_id TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '[]',
    required INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_fields_sfi ON field_configs(sfi_id, sort_order);

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    author_user_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notes_submission ON notes(submission_id, created_at);

  CREATE TABLE IF NOT EXISTS sfi_meta (
    sfi_id TEXT PRIMARY KEY,
    seeded_at INTEGER NOT NULL
  );
`);

// ----------------------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------------------
function hydrateSubmission(row: any) {
  return {
    id: row.id,
    sfi_id: row.sfi_id,
    submitted_at: row.submitted_at,
    email: row.email,
    fields: JSON.parse(row.fields_json || "{}"),
    status: row.status,
  };
}

function hydrateField(row: any) {
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    options: JSON.parse(row.options_json || "[]"),
    required: row.required === 1,
    sort_order: row.sort_order,
  };
}

const VALID_FIELD_TYPES = new Set(["text", "textarea", "checkbox", "dropdown"]);
const VALID_STATUSES = new Set(["new", "in_progress", "resolved", "archived"]);

// Seed a default "Message" field the first time we see a placement. After the initial seed
// the admin can delete or replace the field — subsequent requests won't re-seed.
function ensureDefaultFields(sfiId: string): void {
  if (!sfiId) return;
  const seeded = db.prepare("SELECT seeded_at FROM sfi_meta WHERE sfi_id = ?").get(sfiId);
  if (seeded) return;
  db.prepare("INSERT OR IGNORE INTO sfi_meta (sfi_id, seeded_at) VALUES (?, ?)").run(sfiId, Date.now());
  const count = db.prepare("SELECT COUNT(*) AS cnt FROM field_configs WHERE sfi_id = ?").get(sfiId);
  if ((count as any).cnt > 0) return;
  db.prepare(
    "INSERT INTO field_configs (sfi_id, label, type, options_json, required, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(sfiId, "Message", "textarea", "[]", 0, 0);
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

  // ----- public: fetch the form field config for this placement (anon or admin).
  if (reqPath === "/api/config" && method === "GET") {
    if (!sfiId) return send({ fields: [] });
    ensureDefaultFields(sfiId);
    const rows = db.prepare(
      "SELECT * FROM field_configs WHERE sfi_id = ? ORDER BY sort_order, id"
    ).all(sfiId);
    return send({ fields: rows.map(hydrateField) });
  }

  // ----- public: anonymous submission endpoint.
  if (reqPath === "/api/submit" && method === "POST") {
    if (!sfiId) return send({ error: "sfi_id missing" }, 400);
    const data = parseJsonBody(body);
    if (!data || typeof data.email !== "string") {
      return send({ error: "email is required" }, 400);
    }
    const email = data.email.trim();
    if (!email) return send({ error: "email must not be empty" }, 400);
    if (email.length > 320) return send({ error: "email too long" }, 413);
    const rawFields = (data.fields && typeof data.fields === "object") ? data.fields as Record<string, unknown> : {};

    // Validate required custom fields per the current config and clamp textual values.
    const configured = db.prepare(
      "SELECT * FROM field_configs WHERE sfi_id = ?"
    ).all(sfiId).map(hydrateField);
    const fields: Record<string, unknown> = {};
    for (const f of configured) {
      const v = rawFields[String(f.id)];
      if (f.required) {
        if (f.type === "checkbox") {
          if (v !== true) return send({ error: `"${f.label}" is required` }, 400);
        } else if (v === undefined || v === null || String(v).trim() === "") {
          return send({ error: `"${f.label}" is required` }, 400);
        }
      }
      if (v === undefined) continue;
      if (f.type === "checkbox") fields[String(f.id)] = !!v;
      else {
        const s = String(v);
        if (s.length > 10_000) return send({ error: `"${f.label}" too long` }, 413);
        fields[String(f.id)] = s;
      }
    }

    const now = Date.now();
    const res = db.prepare(
      "INSERT INTO submissions (sfi_id, submitted_at, email, fields_json, status) VALUES (?, ?, ?, ?, 'new')"
    ).run(sfiId, now, email, JSON.stringify(fields));
    const id = Number((res as any).lastInsertRowid);
    const row = db.prepare("SELECT * FROM submissions WHERE id = ?").get(id);
    const sub = hydrateSubmission(row);
    pushToInstance(sfiId, { type: "hd_new_submission", sfi_id: sfiId, submission: sub });
    log(`Help Desk: submission #${id} in placement ${sfiId.slice(0, 8)}… from ${email}`);
    return send({ ok: true, id });
  }

  // ----- admin: everything past this point requires a known user and sfi_id.
  if (reqPath.startsWith("/api/admin/")) {
    if (anon) return send({ error: "forbidden" }, 403);
    if (!sfiId) return send({ error: "sfi_id missing" }, 400);
    ensureDefaultFields(sfiId);

    // Heartbeat — kept so the admin UI can ping cheaply; realtime is delivered via pushToInstance.
    if (reqPath === "/api/admin/register" && method === "POST") {
      return send({ ok: true });
    }

    // Inbox listing.
    if (reqPath === "/api/admin/messages" && method === "GET") {
      const rows = db.prepare(
        "SELECT * FROM submissions WHERE sfi_id = ? ORDER BY submitted_at DESC"
      ).all(sfiId);
      return send({ submissions: rows.map(hydrateSubmission) });
    }

    // Status change.
    const statusMatch = reqPath.match(/^\/api\/admin\/messages\/(\d+)\/status$/);
    if (statusMatch && method === "PUT") {
      const id = parseInt(statusMatch[1]);
      const data = parseJsonBody(body);
      if (!data?.status || !VALID_STATUSES.has(data.status)) return send({ error: "invalid status" }, 400);
      const info = db.prepare(
        "UPDATE submissions SET status = ? WHERE id = ? AND sfi_id = ?"
      ).run(data.status, id, sfiId);
      if ((info as any).changes === 0) return send({ error: "not found" }, 404);
      pushToInstance(sfiId, { type: "hd_submission_updated", sfi_id: sfiId, id, status: data.status });
      return send({ ok: true });
    }

    // Notes list.
    const notesListMatch = reqPath.match(/^\/api\/admin\/messages\/(\d+)\/notes$/);
    if (notesListMatch && method === "GET") {
      const id = parseInt(notesListMatch[1]);
      const owned = db.prepare("SELECT id FROM submissions WHERE id = ? AND sfi_id = ?").get(id, sfiId);
      if (!owned) return send({ error: "not found" }, 404);
      const notes = db.prepare(
        "SELECT * FROM notes WHERE submission_id = ? ORDER BY created_at"
      ).all(id);
      return send({ notes });
    }

    // Add note.
    if (notesListMatch && method === "POST") {
      const id = parseInt(notesListMatch[1]);
      const data = parseJsonBody(body);
      if (!data?.body || typeof data.body !== "string") return send({ error: "body required" }, 400);
      const owned = db.prepare("SELECT id FROM submissions WHERE id = ? AND sfi_id = ?").get(id, sfiId);
      if (!owned) return send({ error: "not found" }, 404);
      const authorName = peer.user_name || "admin";
      db.prepare(
        "INSERT INTO notes (submission_id, author_user_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(id, peer.user_id, authorName, data.body, Date.now());
      const notes = db.prepare(
        "SELECT * FROM notes WHERE submission_id = ? ORDER BY created_at"
      ).all(id);
      pushToInstance(sfiId, { type: "hd_note_added", sfi_id: sfiId, submission_id: id, notes });
      return send({ notes });
    }

    // Delete submission.
    const deleteMatch = reqPath.match(/^\/api\/admin\/messages\/(\d+)$/);
    if (deleteMatch && method === "DELETE") {
      const id = parseInt(deleteMatch[1]);
      const owned = db.prepare("SELECT id FROM submissions WHERE id = ? AND sfi_id = ?").get(id, sfiId);
      if (!owned) return send({ error: "not found" }, 404);
      db.prepare("DELETE FROM notes WHERE submission_id = ?").run(id);
      db.prepare("DELETE FROM submissions WHERE id = ?").run(id);
      pushToInstance(sfiId, { type: "hd_submission_deleted", sfi_id: sfiId, id });
      return send({ ok: true });
    }

    // Field config list.
    if (reqPath === "/api/admin/fields" && method === "GET") {
      const rows = db.prepare(
        "SELECT * FROM field_configs WHERE sfi_id = ? ORDER BY sort_order, id"
      ).all(sfiId);
      return send({ fields: rows.map(hydrateField) });
    }

    // Create field.
    if (reqPath === "/api/admin/fields" && method === "POST") {
      const data = parseJsonBody(body);
      if (!data?.label || typeof data.label !== "string") return send({ error: "label required" }, 400);
      if (!data?.type || !VALID_FIELD_TYPES.has(data.type)) return send({ error: "invalid type" }, 400);
      const options = Array.isArray(data.options) ? data.options.map(String) : [];
      if (data.type === "dropdown" && options.length === 0) return send({ error: "dropdown requires at least one option" }, 400);
      const maxOrder = db.prepare(
        "SELECT COALESCE(MAX(sort_order), -1) AS m FROM field_configs WHERE sfi_id = ?"
      ).get(sfiId);
      const res = db.prepare(
        "INSERT INTO field_configs (sfi_id, label, type, options_json, required, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(sfiId, data.label.trim(), data.type, JSON.stringify(options), data.required ? 1 : 0, ((maxOrder as any).m ?? -1) + 1);
      const id = Number((res as any).lastInsertRowid);
      pushToInstance(sfiId, { type: "hd_fields_changed", sfi_id: sfiId });
      return send({ ok: true, id });
    }

    // Update / delete field.
    const fieldIdMatch = reqPath.match(/^\/api\/admin\/fields\/(\d+)$/);
    if (fieldIdMatch && method === "PUT") {
      const id = parseInt(fieldIdMatch[1]);
      const owned = db.prepare("SELECT id FROM field_configs WHERE id = ? AND sfi_id = ?").get(id, sfiId);
      if (!owned) return send({ error: "not found" }, 404);
      const data = parseJsonBody(body);
      if (!data) return send({ error: "invalid body" }, 400);
      if (typeof data.label === "string") db.prepare("UPDATE field_configs SET label = ? WHERE id = ?").run(data.label.trim(), id);
      if (typeof data.type === "string") {
        if (!VALID_FIELD_TYPES.has(data.type)) return send({ error: "invalid type" }, 400);
        db.prepare("UPDATE field_configs SET type = ? WHERE id = ?").run(data.type, id);
      }
      if (Array.isArray(data.options)) {
        db.prepare("UPDATE field_configs SET options_json = ? WHERE id = ?").run(JSON.stringify(data.options.map(String)), id);
      }
      if (typeof data.required === "boolean") {
        db.prepare("UPDATE field_configs SET required = ? WHERE id = ?").run(data.required ? 1 : 0, id);
      }
      pushToInstance(sfiId, { type: "hd_fields_changed", sfi_id: sfiId });
      return send({ ok: true });
    }

    if (fieldIdMatch && method === "DELETE") {
      const id = parseInt(fieldIdMatch[1]);
      const info = db.prepare("DELETE FROM field_configs WHERE id = ? AND sfi_id = ?").run(id, sfiId);
      if ((info as any).changes === 0) return send({ error: "not found" }, 404);
      pushToInstance(sfiId, { type: "hd_fields_changed", sfi_id: sfiId });
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

log("Help Desk frame is up and running!");
