// ----------------------------------------------------------------------------------------
// Discussion Channel — Per-placement realtime chat for known users in a space.
//
// Auth model:
//   - Anonymous (FAT) visitors get a "private discussion channel" notice and zero API access.
//   - Any signed-in user in the space can post, react, edit settings, and delete their own
//     messages. Space owners can additionally delete other users' messages.
//   - All state is scoped by sfi_id so each placement is its own channel.
//
// Realtime: new messages, deletions, reaction toggles, and pref changes are broadcast via
// pushToInstance(sfi_id, …); framecore handles viewer cap_token tracking.
// ----------------------------------------------------------------------------------------
import {
  log, parsePeerInfo, serveFileAtPath, serveHtmlShell, pushToInstance,
  jsonReply, parseJsonBody, sanitizeText, toIntOrNull,
  frameDataDir, loadJsonFile, saveJsonFile, DatabaseSync, path,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// PER-PLACEMENT PREFS (channel name + theme color), stored as JSON
// ----------------------------------------------------------------------------------------
type Prefs = { title: string; theme: string };
const DEFAULT_PREFS: Prefs = { title: "Discussion", theme: "c1" };
const VALID_THEMES = new Set(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);

const allPrefs: Record<string, Prefs> = loadJsonFile(import.meta.url, "prefs.json", {});
function getPrefs(sfiId: string): Prefs {
  return { ...DEFAULT_PREFS, ...(allPrefs[sfiId] ?? {}) };
}
function setPrefs(sfiId: string, next: Prefs): void {
  allPrefs[sfiId] = next;
  saveJsonFile(import.meta.url, "prefs.json", allPrefs);
}

// ----------------------------------------------------------------------------------------
// DB — messages + reactions, scoped by sfi_id
// ----------------------------------------------------------------------------------------
const db = new DatabaseSync(path.join(frameDataDir(import.meta.url), "channel.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sfi_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_sfi ON messages(sfi_id, created_at);

  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sfi_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    icon TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(message_id, user_id, icon)
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);
`);

// Curated allow-list of Phosphor Light icons used as reactions.
const REACTION_ICONS = [
  "thumbs-up", "heart", "fire", "smiley", "hand-waving",
  "sparkle", "lightning", "rocket", "confetti", "star",
] as const;
const REACTION_ICON_SET = new Set<string>(REACTION_ICONS);

const HISTORY_LIMIT = 200;

// ----------------------------------------------------------------------------------------
// QUERIES
// ----------------------------------------------------------------------------------------
function listMessages(sfiId: string) {
  const msgs = db.prepare(
    "SELECT id, user_id, user_name, body, created_at FROM messages WHERE sfi_id = ? ORDER BY created_at ASC, id ASC LIMIT ?"
  ).all(sfiId, HISTORY_LIMIT) as Array<{
    id: number; user_id: string; user_name: string; body: string; created_at: number;
  }>;
  if (msgs.length === 0) return [];
  const ids = msgs.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(",");
  const rxs = db.prepare(
    `SELECT message_id, user_id, user_name, icon FROM reactions WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`
  ).all(...ids) as Array<{ message_id: number; user_id: string; user_name: string; icon: string }>;
  const byMsg = new Map<number, Array<{ user_id: string; user_name: string; icon: string }>>();
  for (const r of rxs) {
    let bucket = byMsg.get(r.message_id);
    if (!bucket) { bucket = []; byMsg.set(r.message_id, bucket); }
    bucket.push({ user_id: r.user_id, user_name: r.user_name, icon: r.icon });
  }
  return msgs.map((m) => ({ ...m, reactions: byMsg.get(m.id) ?? [] }));
}

function reactionsFor(messageId: number) {
  return db.prepare(
    "SELECT user_id, user_name, icon FROM reactions WHERE message_id = ? ORDER BY created_at ASC"
  ).all(messageId);
}

// ----------------------------------------------------------------------------------------
// HANDLER
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async (replyPort, reqPath, method, _headers, query, body, cookies) => {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;
  const isAnon = peer.is_anon || !peer.user_id;
  const isOwner = peer.is_owner;

  // UI shell — anon viewers receive the same HTML; the iframe checks window.__peer
  // and renders the private notice without making any API calls.
  if (reqPath === "/index.html" && method === "GET") {
    // The script is inline in index.html as <script type="module"> so it can import
    // /lib/js/framelib.js — inlineJs would flatten that to a non-module <script>, which
    // can't use ES module imports, so it's intentionally omitted here.
    return serveHtmlShell(replyPort, new URL("./public/index.html", import.meta.url), {
      peer,
      inlineCss: ["index.css"],
    });
  }

  // Block all API calls from anonymous viewers — fail closed.
  if (isAnon && reqPath.startsWith("/api/")) {
    return jsonReply(replyPort, 403, { error: "private channel" });
  }

  if (reqPath === "/api/state" && method === "GET") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    return jsonReply(replyPort, 200, {
      prefs: getPrefs(sfiId),
      messages: listMessages(sfiId),
      reaction_icons: REACTION_ICONS,
      can_edit_settings: !isAnon,
      me: { user_id: peer.user_id, user_name: peer.user_name },
    });
  }

  if (reqPath === "/api/send" && method === "POST") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    const v = parseJsonBody<{ body?: unknown }>(body);
    const text = sanitizeText(v?.body, 4000);
    if (!text) return jsonReply(replyPort, 400, { error: "body required" });
    const userName = sanitizeText(peer.user_name, 80) || "user";
    const now = Date.now();
    const res = db.prepare(
      "INSERT INTO messages (sfi_id, user_id, user_name, body, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(sfiId, peer.user_id, userName, text, now);
    const id = Number((res as any).lastInsertRowid);
    const msg = { id, user_id: peer.user_id, user_name: userName, body: text, created_at: now, reactions: [] };
    pushToInstance(sfiId, { type: "dc_message", sfi_id: sfiId, message: msg });
    return jsonReply(replyPort, 200, { ok: true, id });
  }

  if (reqPath === "/api/delete" && method === "POST") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    const v = parseJsonBody<{ id?: unknown }>(body);
    const id = toIntOrNull(v?.id);
    if (!id) return jsonReply(replyPort, 400, { error: "id required" });
    const row = db.prepare(
      "SELECT user_id FROM messages WHERE id = ? AND sfi_id = ?"
    ).get(id, sfiId) as { user_id: string } | undefined;
    if (!row) return jsonReply(replyPort, 404, { error: "not found" });
    if (!isOwner && row.user_id !== peer.user_id) return jsonReply(replyPort, 403, { error: "forbidden" });
    db.prepare("DELETE FROM reactions WHERE message_id = ?").run(id);
    db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    pushToInstance(sfiId, { type: "dc_delete", sfi_id: sfiId, id });
    return jsonReply(replyPort, 200, { ok: true });
  }

  // Toggle a reaction: remove if this user already reacted with this icon, otherwise add.
  if (reqPath === "/api/react" && method === "POST") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    const v = parseJsonBody<{ message_id?: unknown; icon?: unknown }>(body);
    const mid = toIntOrNull(v?.message_id);
    const icon = sanitizeText(v?.icon, 40);
    if (!mid || !icon || !REACTION_ICON_SET.has(icon)) return jsonReply(replyPort, 400, { error: "invalid" });
    const owned = db.prepare(
      "SELECT id FROM messages WHERE id = ? AND sfi_id = ?"
    ).get(mid, sfiId);
    if (!owned) return jsonReply(replyPort, 404, { error: "not found" });
    const userName = sanitizeText(peer.user_name, 80) || "user";
    const existing = db.prepare(
      "SELECT id FROM reactions WHERE message_id = ? AND user_id = ? AND icon = ?"
    ).get(mid, peer.user_id, icon) as { id: number } | undefined;
    if (existing) {
      db.prepare("DELETE FROM reactions WHERE id = ?").run(existing.id);
    } else {
      db.prepare(
        "INSERT INTO reactions (sfi_id, message_id, user_id, user_name, icon, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(sfiId, mid, peer.user_id, userName, icon, Date.now());
    }
    const reactions = reactionsFor(mid);
    pushToInstance(sfiId, { type: "dc_reactions", sfi_id: sfiId, message_id: mid, reactions });
    return jsonReply(replyPort, 200, { ok: true });
  }

  if (reqPath === "/api/settings" && method === "POST") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    const v = parseJsonBody<{ title?: unknown; theme?: unknown }>(body);
    const title = sanitizeText(v?.title, 80) || DEFAULT_PREFS.title;
    const themeRaw = sanitizeText(v?.theme, 4);
    const next: Prefs = {
      title,
      theme: VALID_THEMES.has(themeRaw) ? themeRaw : DEFAULT_PREFS.theme,
    };
    setPrefs(sfiId, next);
    pushToInstance(sfiId, { type: "dc_prefs", sfi_id: sfiId, prefs: next });
    return jsonReply(replyPort, 200, { ok: true, prefs: next });
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }
  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

log("Discussion Channel frame is up.");
