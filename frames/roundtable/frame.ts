// ----------------------------------------------------------------------------------------
// Roundtable — Per-placement private discussion + two prioritized lists.
//
// Auth model (two independent owner toggles):
//   - `public_to_space_viewers` — when true, Viewer-role members of the space (members
//     with is_sfi_editor=false) are opted into full participation: chat, add items, vote,
//     delete their own. Editors / owners (is_sfi_editor=true) participate regardless.
//     When OFF, Viewer-role members can still READ this Roundtable (they're members of
//     the space) but cannot mutate anything.
//   - `public_read_view` — when true, even non-members (empty user_id from anonymous FAT
//     visitors, or signed-in users whose only access is a bookmark to this SFI) can READ
//     the channel — no mutations of any kind.
//
//   Resolution:
//     canParticipate = isSfiEditor OR (publicToSpaceViewers AND isSfiMember)
//     canRead        = canParticipate OR isSfiMember OR publicReadView
//     /api/state requires canRead. Every mutation route requires canParticipate.
//     /api/settings additionally requires isOwner.
//   - Owners can additionally delete anyone's message or item.
//   - All state is scoped by sfi_id so each placement is its own roundtable.
//   - Non-members never participate; the participation toggle only governs Viewer-role
//     space members, not anonymous / bookmark visitors. Anonymous read access is the
//     separate `public_read_view` toggle.
//
// Realtime: chat, item, vote, and pref changes are broadcast via pushToInstance(sfi_id, …);
// framecore handles viewer cap_token tracking, including anonymous read-only viewers.
// ----------------------------------------------------------------------------------------
import {
  log, parsePeerInfo, serveFileAtPath, serveHtmlShell, pushToInstance,
  jsonReply, parseJsonBody, sanitizeText, toIntOrNull,
  frameDataDir, loadJsonFile, saveJsonFile, DatabaseSync, path,
} from "@frame-core";

// ----------------------------------------------------------------------------------------
// PER-PLACEMENT PREFS — owner-editable frame settings, stored as JSON
// ----------------------------------------------------------------------------------------
type Prefs = {
  title: string;
  theme: string;
  positive_label: string;
  negative_label: string;
  // When true, Viewer-role space members (members of this space whose role is below
  // Contributor) can fully participate: chat, add items, vote, delete their own. Off by
  // default — Viewers can still READ the channel because they're space members, but
  // can't mutate anything. Editors/Owners participate regardless of this toggle.
  public_to_space_viewers: boolean;
  // When true, non-members (anonymous FAT visitors AND signed-in users whose only
  // access is a bookmark to this SFI) can read the channel in a fully read-only view.
  // They can never post, vote, or delete. Default off. Combine with
  // `public_to_space_viewers` to open up writes to Viewer-role members while keeping a
  // read-only window for outsiders.
  public_read_view: boolean;
};
const DEFAULT_PREFS: Prefs = {
  title: "Roundtable",
  theme: "c1",
  positive_label: "Positives",
  negative_label: "Negatives",
  public_to_space_viewers: false,
  public_read_view: false,
};
const VALID_THEMES = new Set(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12"]);

const allPrefs: Record<string, Prefs> = loadJsonFile(import.meta.url, "prefs.json", {});
function getPrefs(sfiId: string): Prefs {
  // Note: existing placements with the legacy `public_to_users` field are NOT migrated —
  // the field is just ignored. The new `public_to_space_viewers` toggle defaults to off,
  // so previously-elevated participants drop back to the default access tier and the
  // owner can re-enable participation under the new clearer semantics if they want it.
  return { ...DEFAULT_PREFS, ...(allPrefs[sfiId] ?? {}) };
}
function setPrefs(sfiId: string, next: Prefs): void {
  allPrefs[sfiId] = next;
  saveJsonFile(import.meta.url, "prefs.json", allPrefs);
}

// ----------------------------------------------------------------------------------------
// DB — messages, list items, item votes; all scoped by sfi_id
// ----------------------------------------------------------------------------------------
const db = new DatabaseSync(path.join(frameDataDir(import.meta.url), "roundtable.db"));
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

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sfi_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_items_sfi_kind ON items(sfi_id, kind);

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sfi_id TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(item_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_votes_item ON votes(item_id);
`);

const KIND_POSITIVE = "positive";
const KIND_NEGATIVE = "negative";
const VALID_KINDS = new Set([KIND_POSITIVE, KIND_NEGATIVE]);

const MESSAGE_HISTORY_LIMIT = 200;
const ITEM_LIMIT = 500;
const MESSAGE_MAX_LEN = 4000;
const ITEM_MAX_LEN = 280;

// ----------------------------------------------------------------------------------------
// QUERIES
// ----------------------------------------------------------------------------------------
function listMessages(sfiId: string) {
  return db.prepare(
    "SELECT id, user_id, user_name, body, created_at FROM messages WHERE sfi_id = ? ORDER BY created_at ASC, id ASC LIMIT ?"
  ).all(sfiId, MESSAGE_HISTORY_LIMIT) as Array<{
    id: number; user_id: string; user_name: string; body: string; created_at: number;
  }>;
}

// Items joined with vote counts and a flag per voter indicating whether the requesting user
// already voted. Sorted by votes DESC, then created_at DESC, then id DESC for stable order.
function listItems(sfiId: string, kind: string, meUserId: string) {
  const rows = db.prepare(`
    SELECT
      i.id, i.user_id, i.user_name, i.body, i.created_at,
      COALESCE(v.votes, 0) AS votes,
      CASE WHEN mv.user_id IS NULL THEN 0 ELSE 1 END AS i_voted
    FROM items i
    LEFT JOIN (
      SELECT item_id, COUNT(*) AS votes FROM votes GROUP BY item_id
    ) v ON v.item_id = i.id
    LEFT JOIN votes mv ON mv.item_id = i.id AND mv.user_id = ?
    WHERE i.sfi_id = ? AND i.kind = ?
    ORDER BY votes DESC, i.created_at DESC, i.id DESC
    LIMIT ?
  `).all(meUserId, sfiId, kind, ITEM_LIMIT) as Array<{
    id: number; user_id: string; user_name: string; body: string;
    created_at: number; votes: number; i_voted: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    user_name: r.user_name,
    body: r.body,
    created_at: r.created_at,
    votes: r.votes,
    i_voted: r.i_voted === 1,
  }));
}

function getItemRow(itemId: number, sfiId: string): { user_id: string; kind: string } | undefined {
  return db.prepare(
    "SELECT user_id, kind FROM items WHERE id = ? AND sfi_id = ?"
  ).get(itemId, sfiId) as { user_id: string; kind: string } | undefined;
}

// ----------------------------------------------------------------------------------------
// HANDLER
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async (replyPort, reqPath, method, _headers, query, body, cookies) => {
  const peer = parsePeerInfo(query, cookies);
  const sfiId = peer.sfi_id;
  const isSfiMember = peer.is_sfi_member;
  const isSfiEditor = peer.is_sfi_editor;
  const isOwner = peer.is_owner;

  // UI shell — same HTML for everyone; the iframe attempts /api/state and falls back to a
  // private-frame notice on 403 (truly anonymous viewers or non-members on a non-public
  // Roundtable).
  if (reqPath === "/index.html" && method === "GET") {
    // The script is inline in index.html as <script type="module"> so it can import
    // /lib/js/framelib.js — inlineJs would flatten that to a non-module <script>, which
    // can't use ES module imports, so it's intentionally omitted here.
    return serveHtmlShell(replyPort, new URL("./public/index.html", import.meta.url), {
      peer,
      inlineCss: ["index.css"],
    });
  }

  // Auth — two-tier:
  //   canParticipate: full read+write (chat, items, votes). SFI editors (role > Viewer)
  //     always; Viewer-role space members when the owner has turned on
  //     `public_to_space_viewers`. Non-members never participate.
  //   canRead:        canParticipate OR isSfiMember (so Viewer-role members can always
  //                   follow along read-only) OR (public_read_view AND any visitor).
  // Mutation routes additionally short-circuit with `if (!canParticipate)` below so a
  // read-only viewer that tries to POST gets a clean 403 instead of an unauthorized write.
  const authPrefs = sfiId ? getPrefs(sfiId) : DEFAULT_PREFS;
  const publicToSpaceViewers = authPrefs.public_to_space_viewers === true;
  const publicReadView = authPrefs.public_read_view === true;
  const canParticipate = isSfiEditor || (publicToSpaceViewers && isSfiMember);
  const canRead = canParticipate || isSfiMember || publicReadView;
  if (!canRead && reqPath.startsWith("/api/")) {
    return jsonReply(replyPort, 403, { error: "private frame" });
  }

  if (reqPath === "/api/state" && method === "GET") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    return jsonReply(replyPort, 200, {
      prefs: getPrefs(sfiId),
      messages: listMessages(sfiId),
      positives: listItems(sfiId, KIND_POSITIVE, peer.user_id),
      negatives: listItems(sfiId, KIND_NEGATIVE, peer.user_id),
      can_edit_settings: isOwner,
      can_participate: canParticipate,
      me: { user_id: peer.user_id, user_name: peer.user_name, is_owner: isOwner },
    });
  }

  // Every mutation route below requires canParticipate. Read-only viewers (public_read_view
  // with no participation rights) get a single uniform 403 here instead of per-route checks.
  if (!canParticipate && reqPath.startsWith("/api/")) {
    return jsonReply(replyPort, 403, { error: "read only" });
  }

  // -------- CHAT --------
  if (reqPath === "/api/send" && method === "POST") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    const v = parseJsonBody<{ body?: unknown }>(body);
    const text = sanitizeText(v?.body, MESSAGE_MAX_LEN);
    if (!text) return jsonReply(replyPort, 400, { error: "body required" });
    const userName = sanitizeText(peer.user_name, 80) || "user";
    const now = Date.now();
    const res = db.prepare(
      "INSERT INTO messages (sfi_id, user_id, user_name, body, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(sfiId, peer.user_id, userName, text, now);
    const id = Number((res as { lastInsertRowid: number | bigint }).lastInsertRowid);
    const msg = { id, user_id: peer.user_id, user_name: userName, body: text, created_at: now };
    pushToInstance(sfiId, { type: "rt_message", sfi_id: sfiId, message: msg });
    return jsonReply(replyPort, 200, { ok: true, id });
  }

  if (reqPath === "/api/delete-message" && method === "POST") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    const v = parseJsonBody<{ id?: unknown }>(body);
    const id = toIntOrNull(v?.id);
    if (!id) return jsonReply(replyPort, 400, { error: "id required" });
    const row = db.prepare(
      "SELECT user_id FROM messages WHERE id = ? AND sfi_id = ?"
    ).get(id, sfiId) as { user_id: string } | undefined;
    if (!row) return jsonReply(replyPort, 404, { error: "not found" });
    if (!isOwner && row.user_id !== peer.user_id) return jsonReply(replyPort, 403, { error: "forbidden" });
    db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    pushToInstance(sfiId, { type: "rt_message_delete", sfi_id: sfiId, id });
    return jsonReply(replyPort, 200, { ok: true });
  }

  // -------- LIST ITEMS --------
  if (reqPath === "/api/item-add" && method === "POST") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    const v = parseJsonBody<{ kind?: unknown; body?: unknown }>(body);
    const kind = sanitizeText(v?.kind, 20);
    if (!VALID_KINDS.has(kind)) return jsonReply(replyPort, 400, { error: "invalid kind" });
    const text = sanitizeText(v?.body, ITEM_MAX_LEN);
    if (!text) return jsonReply(replyPort, 400, { error: "body required" });
    const userName = sanitizeText(peer.user_name, 80) || "user";
    const now = Date.now();
    const res = db.prepare(
      "INSERT INTO items (sfi_id, kind, user_id, user_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(sfiId, kind, peer.user_id, userName, text, now);
    const id = Number((res as { lastInsertRowid: number | bigint }).lastInsertRowid);
    // Adding an item counts as the author's own +1 — sharing an idea is itself a vote
    // for it. Other viewers will receive votes=1 / i_voted=false (their personal flag
    // gets corrected on receive based on whether they authored the item).
    db.prepare(
      "INSERT INTO votes (sfi_id, item_id, user_id, user_name, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(sfiId, id, peer.user_id, userName, now);
    const item = {
      id, user_id: peer.user_id, user_name: userName,
      body: text, created_at: now, votes: 1, i_voted: true,
    };
    pushToInstance(sfiId, { type: "rt_item_add", sfi_id: sfiId, kind, item });
    return jsonReply(replyPort, 200, { ok: true, id });
  }

  if (reqPath === "/api/item-delete" && method === "POST") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    const v = parseJsonBody<{ id?: unknown }>(body);
    const id = toIntOrNull(v?.id);
    if (!id) return jsonReply(replyPort, 400, { error: "id required" });
    const row = getItemRow(id, sfiId);
    if (!row) return jsonReply(replyPort, 404, { error: "not found" });
    if (!isOwner && row.user_id !== peer.user_id) return jsonReply(replyPort, 403, { error: "forbidden" });
    db.prepare("DELETE FROM votes WHERE item_id = ?").run(id);
    db.prepare("DELETE FROM items WHERE id = ?").run(id);
    pushToInstance(sfiId, { type: "rt_item_delete", sfi_id: sfiId, kind: row.kind, id });
    return jsonReply(replyPort, 200, { ok: true });
  }

  // Toggle a +1 from the requesting user. Self-votes are allowed — the value of an item
  // is the count of distinct members who think it matters, including its author.
  if (reqPath === "/api/item-vote" && method === "POST") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    const v = parseJsonBody<{ id?: unknown }>(body);
    const id = toIntOrNull(v?.id);
    if (!id) return jsonReply(replyPort, 400, { error: "id required" });
    const row = getItemRow(id, sfiId);
    if (!row) return jsonReply(replyPort, 404, { error: "not found" });
    const userName = sanitizeText(peer.user_name, 80) || "user";
    const existing = db.prepare(
      "SELECT id FROM votes WHERE item_id = ? AND user_id = ?"
    ).get(id, peer.user_id) as { id: number } | undefined;
    if (existing) {
      db.prepare("DELETE FROM votes WHERE id = ?").run(existing.id);
    } else {
      db.prepare(
        "INSERT INTO votes (sfi_id, item_id, user_id, user_name, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(sfiId, id, peer.user_id, userName, Date.now());
    }
    const countRow = db.prepare(
      "SELECT COUNT(*) AS n FROM votes WHERE item_id = ?"
    ).get(id) as { n: number };
    pushToInstance(sfiId, {
      type: "rt_item_vote", sfi_id: sfiId, kind: row.kind, id,
      votes: countRow.n,
    });
    return jsonReply(replyPort, 200, { ok: true, votes: countRow.n, i_voted: !existing });
  }

  // -------- OWNER SETTINGS --------
  if (reqPath === "/api/settings" && method === "POST") {
    if (!sfiId) return jsonReply(replyPort, 400, { error: "sfi_id missing" });
    if (!isOwner) return jsonReply(replyPort, 403, { error: "owner only" });
    const v = parseJsonBody<{ title?: unknown; theme?: unknown; positive_label?: unknown; negative_label?: unknown; public_to_space_viewers?: unknown; public_read_view?: unknown }>(body);
    const title = sanitizeText(v?.title, 80) || DEFAULT_PREFS.title;
    const themeRaw = sanitizeText(v?.theme, 4);
    const positiveLabel = sanitizeText(v?.positive_label, 40) || DEFAULT_PREFS.positive_label;
    const negativeLabel = sanitizeText(v?.negative_label, 40) || DEFAULT_PREFS.negative_label;
    const next: Prefs = {
      title,
      theme: VALID_THEMES.has(themeRaw) ? themeRaw : DEFAULT_PREFS.theme,
      positive_label: positiveLabel,
      negative_label: negativeLabel,
      public_to_space_viewers: v?.public_to_space_viewers === true,
      public_read_view: v?.public_read_view === true,
    };
    setPrefs(sfiId, next);
    pushToInstance(sfiId, { type: "rt_prefs", sfi_id: sfiId, prefs: next });
    return jsonReply(replyPort, 200, { ok: true, prefs: next });
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }
  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

log("Roundtable frame is up.");
