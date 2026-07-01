// ----------------------------------------------------------------------------------------
// Outpost — a lightweight public posting board, one per placement (sfi_id).
//
// Members (editors) publish short posts to share with the world; anyone with the frame's
// share link can read them. A post carries the author's name, the moment it was shared,
// free text (with auto-clickable URLs handled frontend-side), an optional light "kind"
// (thought / question / status / announcement), optional attached media (image / audio /
// video / file), and an optional brief poll that any reader may vote in.
//
// The feed is served in reverse-chronological pages (newest first) via a keyset cursor on
// created_ms, so a long-running community's board stays cheap to load and scroll.
//
// Design axes:
//   privacy:        privacy-public-view  — three tiers. Non-members and Viewer-role members
//                                           get a read-only feed; editors (Contributor+ / owner)
//                                           get the composer. Writes are gated on
//                                           `peer.is_sfi_editor`, NEVER on `is_sfi_member`.
//                                           (Poll voting is a softer gate — any real Seamside
//                                           user may vote, member or not, but NOT anonymous
//                                           web viewers, who see results read-only.)
//   data_storage:   storage-local-db      — one local SQLite database PER SFI at
//                                           data/outposts/<sfi>/posts.db (posts / media rows /
//                                           votes / prefs) so a large, active community's feed
//                                           stays fast to index, page, and search. Attached media
//                                           bytes still live as files in a <post_id>/ subfolder
//                                           beside the db. Per-device — it does NOT sync to peers;
//                                           the host serves its posts to viewers over HTTP.
//   view_realtime:  view-collaborative    — every mutation calls pushToInstance so all viewers
//                                           of the placement refresh live.
//   settings_scope: settings-per-sfi      — a separate db (and prefs row) per peer.sfi_id.
// ----------------------------------------------------------------------------------------
import {
  log, jsonReply, parseJsonBody, parsePeerInfo, pushToInstance,
  frameDataDir, serveFileAtPath, sanitizeText, clampInt, toIntOrNull, path, DatabaseSync,
} from "@frame-core";

type Peer = ReturnType<typeof parsePeerInfo>;

// ----- Shapes ---------------------------------------------------------------------------
type Kind = "thought" | "question" | "status" | "announcement";
const KINDS: Kind[] = ["thought", "question", "status", "announcement"];

type Prefs = {
  title: string;                       // heading shown at the top of the outpost
  tagline: string;                     // one-line description under the heading
  who_can_post: "owner" | "editors";   // who may publish
};
const DEFAULT_PREFS: Prefs = { title: "Outpost", tagline: "", who_can_post: "editors" };

// A post row as read back from SQLite (poll_options is a JSON string or null).
type PostRow = {
  id: string; author: string; author_user_id: string; created_ms: number;
  kind: string; text: string; poll_options: string | null;
};
type MediaRow = { id: string; post_id: string; name: string; mime: string; size: number };

// ----- Limits ---------------------------------------------------------------------------
const MAX_TEXT = 4000;
const MAX_TAGLINE = 160;
const MAX_TITLE = 80;
const MAX_MEDIA_PER_POST = 6;
const MAX_MEDIA_MB = 50;
const MAX_POLL_OPTIONS = 6;
const MIN_POLL_OPTIONS = 2;
const MAX_OPTION_LEN = 120;
const DEFAULT_PAGE = 15;   // posts per feed page
const MAX_PAGE = 50;

// ----- On-disk layout -------------------------------------------------------------------
// data/outposts/<sfi_slug>/posts.db            — SQLite: prefs, posts, media rows, votes
// data/outposts/<sfi_slug>/<post_id>/<media_id> — one file per attached media item (bytes)
const OUTPOSTS_DIR = path.join(frameDataDir(import.meta.url), "outposts");

function sfiSlug(sfiId: string): string {
  return (sfiId || "").replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
}
function storeDir(sfiId: string): string {
  return path.join(OUTPOSTS_DIR, sfiSlug(sfiId));
}
function postDir(sfiId: string, postId: string): string {
  return path.join(storeDir(sfiId), postId);
}

// ----- Per-SFI database handle (opened lazily, cached for the worker's lifetime) --------
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS prefs (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    title        TEXT NOT NULL DEFAULT 'Outpost',
    tagline      TEXT NOT NULL DEFAULT '',
    who_can_post TEXT NOT NULL DEFAULT 'editors'
  );
  INSERT OR IGNORE INTO prefs (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS posts (
    id             TEXT PRIMARY KEY,
    author         TEXT NOT NULL DEFAULT '',
    author_user_id TEXT NOT NULL DEFAULT '',
    created_ms     INTEGER NOT NULL,
    kind           TEXT NOT NULL DEFAULT 'thought',
    text           TEXT NOT NULL DEFAULT '',
    poll_options   TEXT                       -- JSON array of strings, or NULL if not a poll
  );
  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_ms DESC);

  CREATE TABLE IF NOT EXISTS media (
    id      TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    name    TEXT NOT NULL,
    mime    TEXT NOT NULL,
    size    INTEGER NOT NULL,
    ord     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id);

  CREATE TABLE IF NOT EXISTS votes (
    post_id TEXT NOT NULL,
    voter   TEXT NOT NULL,
    choice  INTEGER NOT NULL,
    PRIMARY KEY (post_id, voter)
  );
  CREATE INDEX IF NOT EXISTS idx_votes_post ON votes(post_id);
`;

type Stmt = ReturnType<DatabaseSync["prepare"]>;
type Handle = {
  db: DatabaseSync;
  prefsGet: Stmt; prefsSet: Stmt;
  listRecent: Stmt; listBefore: Stmt;
  getPost: Stmt; insertPost: Stmt; deletePost: Stmt;
  getMedia: Stmt; countMedia: Stmt; insertMedia: Stmt; deleteMediaForPost: Stmt;
  upsertVote: Stmt; deleteVotesForPost: Stmt;
};

const handles = new Map<string, Handle>();
function handle(sfiId: string): Handle {
  const slug = sfiSlug(sfiId);
  const existing = handles.get(slug);
  if (existing) return existing;

  Deno.mkdirSync(storeDir(sfiId), { recursive: true });
  const db = new DatabaseSync(path.join(storeDir(sfiId), "posts.db"));
  db.exec(SCHEMA);
  const cols = "id, author, author_user_id, created_ms, kind, text, poll_options";
  const h: Handle = {
    db,
    prefsGet:   db.prepare("SELECT title, tagline, who_can_post FROM prefs WHERE id = 1"),
    prefsSet:   db.prepare("UPDATE prefs SET title = ?, tagline = ?, who_can_post = ? WHERE id = 1"),
    // Reverse-chronological pages: newest first, then keyset by created_ms for older pages.
    listRecent: db.prepare(`SELECT ${cols} FROM posts ORDER BY created_ms DESC LIMIT ?`),
    listBefore: db.prepare(`SELECT ${cols} FROM posts WHERE created_ms < ? ORDER BY created_ms DESC LIMIT ?`),
    getPost:    db.prepare(`SELECT ${cols} FROM posts WHERE id = ?`),
    insertPost: db.prepare("INSERT INTO posts (id, author, author_user_id, created_ms, kind, text, poll_options) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    deletePost: db.prepare("DELETE FROM posts WHERE id = ?"),
    getMedia:   db.prepare("SELECT name, mime FROM media WHERE id = ? AND post_id = ?"),
    countMedia: db.prepare("SELECT COUNT(*) AS n FROM media WHERE post_id = ?"),
    insertMedia: db.prepare("INSERT INTO media (id, post_id, name, mime, size, ord) VALUES (?, ?, ?, ?, ?, ?)"),
    deleteMediaForPost: db.prepare("DELETE FROM media WHERE post_id = ?"),
    upsertVote: db.prepare("INSERT INTO votes (post_id, voter, choice) VALUES (?, ?, ?) ON CONFLICT(post_id, voter) DO UPDATE SET choice = excluded.choice"),
    deleteVotesForPost: db.prepare("DELETE FROM votes WHERE post_id = ?"),
  };
  handles.set(slug, h);
  return h;
}

function getPrefs(sfiId: string): Prefs {
  const row = handle(sfiId).prefsGet.get() as Partial<Prefs> | undefined;
  return { ...DEFAULT_PREFS, ...(row || {}) };
}

// ----- Ids / validation -----------------------------------------------------------------
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
function isMediaKind(mime: string): { image: boolean; video: boolean; audio: boolean } {
  return { image: mime.startsWith("image/"), video: mime.startsWith("video/"), audio: mime.startsWith("audio/") };
}
function safeName(raw: unknown): string {
  let n = String(raw ?? "").split(/[\\/]/).pop() || "";
  n = n.replace(/[\x00-\x1f]/g, "").replace(/^\.+/, "").trim();
  if (n.length > 200) n = n.slice(0, 200);
  return n || "file";
}

// ----- Permission predicates ------------------------------------------------------------
function canPost(peer: Peer, prefs: Prefs): boolean {
  return prefs.who_can_post === "owner" ? peer.is_owner : peer.is_sfi_editor;
}
function canDeletePost(peer: Peer, authorUserId: string): boolean {
  return peer.is_owner || (peer.is_sfi_editor && !!peer.user_id && authorUserId === peer.user_id);
}
// Poll voting is limited to real Seamside users (signed-in, non-anonymous) — they need not
// be a known contact, just an actual account, not an anonymous web viewer. Anonymous readers
// can see live results but can't cast a vote. A voter is identified by their stable user_id.
function voterId(peer: Peer): string {
  return (!peer.is_anon && peer.user_id) ? "u:" + peer.user_id : "";
}
function canVote(peer: Peer): boolean {
  return voterId(peer) !== "";
}

// ----- Public projection ----------------------------------------------------------------
function publicMedia(m: MediaRow) {
  const k = isMediaKind(m.mime);
  return { id: m.id, name: m.name, mime: m.mime, size: m.size, is_image: k.image, is_video: k.video, is_audio: k.audio };
}

// Project a set of post rows into the public shape, scoping media + vote lookups to just
// these ids (one grouped query each) so a page stays cheap regardless of total feed size.
function projectPosts(h: Handle, rows: PostRow[], peer: Peer, vkey: string) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => "?").join(",");

  const mediaByPost = new Map<string, MediaRow[]>();
  for (const m of h.db.prepare(`SELECT id, post_id, name, mime, size FROM media WHERE post_id IN (${ph}) ORDER BY post_id, ord`).all(...ids) as MediaRow[]) {
    (mediaByPost.get(m.post_id) ?? mediaByPost.set(m.post_id, []).get(m.post_id)!).push(m);
  }
  const countsByPost = new Map<string, Map<number, number>>();
  for (const t of h.db.prepare(`SELECT post_id, choice, COUNT(*) AS c FROM votes WHERE post_id IN (${ph}) GROUP BY post_id, choice`).all(...ids) as { post_id: string; choice: number; c: number }[]) {
    (countsByPost.get(t.post_id) ?? countsByPost.set(t.post_id, new Map()).get(t.post_id)!).set(Number(t.choice), Number(t.c));
  }
  const myByPost = new Map<string, number>();
  if (vkey) for (const r of h.db.prepare(`SELECT post_id, choice FROM votes WHERE voter = ? AND post_id IN (${ph})`).all(vkey, ...ids) as { post_id: string; choice: number }[]) {
    myByPost.set(r.post_id, Number(r.choice));
  }

  return rows.map((p) => {
    let poll = null;
    if (p.poll_options) {
      let options: string[] = [];
      try { options = JSON.parse(p.poll_options); } catch { /* corrupt — treat as no poll */ }
      if (Array.isArray(options) && options.length) {
        const cm = countsByPost.get(p.id) || new Map<number, number>();
        const counts = options.map((_, i) => cm.get(i) || 0);
        const total = counts.reduce((a, b) => a + b, 0);
        poll = { options, counts, total, my_choice: myByPost.has(p.id) ? myByPost.get(p.id)! : null };
      }
    }
    return {
      id: p.id,
      author: p.author || "Someone",
      created_ms: p.created_ms,
      kind: p.kind,
      text: p.text,
      media: (mediaByPost.get(p.id) || []).map(publicMedia),
      poll,
      can_delete: canDeletePost(peer, p.author_user_id),
    };
  });
}

// One reverse-chronological page. `before` (a created_ms cursor) is null for the first page.
function pagePayload(h: Handle, peer: Peer, vkey: string, before: number | null, limit: number) {
  const rows = (before == null
    ? h.listRecent.all(limit + 1)
    : h.listBefore.all(before, limit + 1)) as PostRow[];
  const has_more = rows.length > limit;
  const page = has_more ? rows.slice(0, limit) : rows;
  return {
    posts: projectPosts(h, page, peer, vkey),
    has_more,
    next_before: page.length ? page[page.length - 1].created_ms : null,
  };
}

function projectOne(h: Handle, id: string, peer: Peer, vkey: string) {
  const row = h.getPost.get(id) as PostRow | undefined;
  return row ? projectPosts(h, [row], peer, vkey)[0] : null;
}

// ----- Networking -----------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  // Static assets — open to everyone (all tiers need the shell to render).
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Identity + prefs + the FIRST page of the feed, in one round trip. ?voter= carries the
  // anon device token; ?limit= lets a live-refresh re-request the range already on screen.
  if (reqPath === "/api/state" && method === "GET") {
    const h = handle(peer.sfi_id);
    const prefs = getPrefs(peer.sfi_id);
    const limit = clampInt(toIntOrNull(query.limit) ?? DEFAULT_PAGE, 1, MAX_PAGE);
    return jsonReply(replyPort, 200, {
      me: {
        is_anon: peer.is_anon, is_sfi_member: peer.is_sfi_member,
        is_sfi_editor: peer.is_sfi_editor, is_owner: peer.is_owner,
        user_name: peer.user_name, space_color: peer.space_color,
      },
      prefs,
      can_post: canPost(peer, prefs),
      can_vote: canVote(peer),
      ...pagePayload(h, peer, voterId(peer), null, limit),
    });
  }

  // Older pages: ?before=<created_ms cursor>&limit=  (public — read-only feed).
  if (reqPath === "/api/posts" && method === "GET") {
    const h = handle(peer.sfi_id);
    const before = toIntOrNull(query.before);
    const limit = clampInt(toIntOrNull(query.limit) ?? DEFAULT_PAGE, 1, MAX_PAGE);
    return jsonReply(replyPort, 200, pagePayload(h, peer, voterId(peer), before, limit));
  }

  // Create a post (metadata only; media is uploaded afterward). Editors only.
  if (reqPath === "/api/post" && method === "POST") {
    const prefs = getPrefs(peer.sfi_id);
    if (!canPost(peer, prefs)) return jsonReply(replyPort, 403, { error: "editors only" });
    const v = parseJsonBody<{ text?: string; kind?: string; poll_options?: unknown[] }>(body) || {};
    const text = sanitizeText(v.text, MAX_TEXT);
    const kind: Kind = KINDS.includes(v.kind as Kind) ? (v.kind as Kind) : "thought";

    let pollJson: string | null = null;
    if (Array.isArray(v.poll_options)) {
      const options = v.poll_options
        .map((o: unknown) => sanitizeText(o, MAX_OPTION_LEN))
        .filter((o: string) => o.length > 0)
        .slice(0, MAX_POLL_OPTIONS);
      if (options.length >= MIN_POLL_OPTIONS) pollJson = JSON.stringify(options);
    }
    if (!text && !pollJson) return jsonReply(replyPort, 400, { error: "a post needs text, a poll, or media" });

    const h = handle(peer.sfi_id);
    const id = crypto.randomUUID();
    h.insertPost.run(id, peer.user_name || "Someone", peer.user_id || "", Date.now(), kind, text, pollJson);
    pushToInstance(peer.sfi_id, { type: "outpost_changed" });
    return jsonReply(replyPort, 200, { post_id: id, post: projectOne(h, id, peer, voterId(peer)) });
  }

  // Attach media to a post you just created. Bytes ride in the raw body, name in ?name=.
  if (reqPath.startsWith("/api/post/") && reqPath.endsWith("/media") && method === "POST") {
    const postId = reqPath.slice("/api/post/".length, -"/media".length);
    if (!ID_RE.test(postId)) return jsonReply(replyPort, 400, { error: "bad post id" });
    const h = handle(peer.sfi_id);
    if (!canPost(peer, getPrefs(peer.sfi_id))) return jsonReply(replyPort, 403, { error: "editors only" });
    const post = h.getPost.get(postId) as PostRow | undefined;
    if (!post) return jsonReply(replyPort, 404, { error: "post not found" });
    if (!canDeletePost(peer, post.author_user_id)) return jsonReply(replyPort, 403, { error: "not your post" });
    const ord = Number((h.countMedia.get(postId) as { n: number }).n);
    if (ord >= MAX_MEDIA_PER_POST) return jsonReply(replyPort, 409, { error: `max ${MAX_MEDIA_PER_POST} attachments` });
    if (body.byteLength > MAX_MEDIA_MB * 1024 * 1024) return jsonReply(replyPort, 413, { error: `file exceeds ${MAX_MEDIA_MB} MB` });

    const name = safeName(query.name);
    const mime = sanitizeText(query.mime, 120) || "application/octet-stream";
    const mediaId = crypto.randomUUID();
    const dir = postDir(peer.sfi_id, postId);
    Deno.mkdirSync(dir, { recursive: true });
    Deno.writeFileSync(path.join(dir, mediaId), new Uint8Array(body));
    h.insertMedia.run(mediaId, postId, name, mime, body.byteLength, ord);
    pushToInstance(peer.sfi_id, { type: "outpost_changed" });
    return jsonReply(replyPort, 200, { ok: true });
  }

  // Serve a media file inline (public — anyone with the link may view it).
  if (reqPath.startsWith("/api/media/") && method === "GET") {
    const parts = reqPath.slice("/api/media/".length).split("/");
    if (parts.length !== 2 || !ID_RE.test(parts[0]) || !ID_RE.test(parts[1])) {
      return jsonReply(replyPort, 400, { error: "bad path" });
    }
    const [postId, mediaId] = parts;
    const media = handle(peer.sfi_id).getMedia.get(mediaId, postId) as { name: string; mime: string } | undefined;
    if (!media) return jsonReply(replyPort, 404, { error: "not found" });
    let buf: Uint8Array;
    try { buf = Deno.readFileSync(path.join(postDir(peer.sfi_id, postId), mediaId)); }
    catch { return jsonReply(replyPort, 404, { error: "not found" }); }
    const asciiName = media.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    return replyPort.postMessage({
      status: 200, body: buf, contentType: media.mime,
      headers: { "Content-Disposition": `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(media.name)}` },
    }, [buf.buffer]);
  }

  // Vote in a poll. Restricted to real Seamside users (non-anonymous); anonymous web viewers
  // are rejected here and don't see the control. One vote per user_id; re-voting replaces the
  // previous choice. Returns just the updated post so the reader's scroll position is untouched.
  if (reqPath === "/api/vote" && method === "POST") {
    if (!canVote(peer)) return jsonReply(replyPort, 403, { error: "sign in to Seamside to vote" });
    const v = parseJsonBody<{ post_id?: string; option?: number }>(body) || {};
    const vkey = voterId(peer);
    const h = handle(peer.sfi_id);
    const post = h.getPost.get(v.post_id ?? "") as PostRow | undefined;
    if (!post || !post.poll_options) return jsonReply(replyPort, 404, { error: "poll not found" });
    let options: string[] = [];
    try { options = JSON.parse(post.poll_options); } catch { /* corrupt */ }
    const opt = clampInt(Number(v.option), 0, options.length - 1);
    if (Number(v.option) !== opt) return jsonReply(replyPort, 400, { error: "bad option" });
    h.upsertVote.run(post.id, vkey, opt);
    pushToInstance(peer.sfi_id, { type: "outpost_changed" });
    return jsonReply(replyPort, 200, { post: projectOne(h, post.id, peer, vkey) });
  }

  // Delete a post (owner, or the editor who wrote it). Removes its media rows + files too.
  if (reqPath.startsWith("/api/delete/") && method === "POST") {
    const postId = reqPath.slice("/api/delete/".length);
    if (!ID_RE.test(postId)) return jsonReply(replyPort, 400, { error: "bad id" });
    const h = handle(peer.sfi_id);
    const post = h.getPost.get(postId) as PostRow | undefined;
    if (!post) return jsonReply(replyPort, 404, { error: "not found" });
    if (!canDeletePost(peer, post.author_user_id)) return jsonReply(replyPort, 403, { error: "not allowed" });
    h.deleteVotesForPost.run(postId);
    h.deleteMediaForPost.run(postId);
    h.deletePost.run(postId);
    try { Deno.removeSync(postDir(peer.sfi_id, postId), { recursive: true }); } catch { /* no media */ }
    pushToInstance(peer.sfi_id, { type: "outpost_changed" });
    return jsonReply(replyPort, 200, { ok: true });
  }

  // Owner-only: update this outpost's heading, tagline, and who-can-post setting.
  if (reqPath === "/api/prefs" && method === "POST") {
    if (!peer.is_owner) return jsonReply(replyPort, 403, { error: "owner only" });
    const v = parseJsonBody<Partial<Prefs>>(body) || {};
    handle(peer.sfi_id).prefsSet.run(
      sanitizeText(v.title, MAX_TITLE) || DEFAULT_PREFS.title,
      sanitizeText(v.tagline, MAX_TAGLINE),
      v.who_can_post === "owner" ? "owner" : "editors",
    );
    pushToInstance(peer.sfi_id, { type: "outpost_changed" });
    return jsonReply(replyPort, 200, { prefs: getPrefs(peer.sfi_id) });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};

log("Outpost frame is up and running!");
