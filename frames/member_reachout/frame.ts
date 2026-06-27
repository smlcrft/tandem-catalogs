// ----------------------------------------------------------------------------------------
// Member Reachout — send updates / notifications to the people in your roster.
//
// Contacts (name, email, role, optional phone) live in the SAME shared "members" SyncTable
// that the Member Manager frame uses. We declare the same table key + minimum schema; when
// the owner places this frame they bind it to the existing Members table in the picker, so
// both frames read one roster. This frame only READS the roster — it never mutates members.
//
// Sent messages are logged to a local JSON file keyed by sfi_id (space_frame_instance_id),
// for this device's reference only. The log records date, audience (role(s) / everyone) and
// the send method (email or text). The actual sending happens OS-side: the frontend builds a
// `mailto:` (all recipients bcc'd) or a per-person `sms:` link and asks the OS to open it.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, pushToInstance, parsePeerInfo,
  declareTables, ensureTables, table, renderWaitingForOwner,
  jsonReply, parseJsonBody, sanitizeText, clampInt,
  loadJsonFile, saveJsonFile,
} from "@frame-core";

// Minimum schema required of the bound table. We deliberately declare only the three
// columns the original Member Manager release shipped (name / email / role) so the binding
// picker offers BOTH old and new Members tables (it does a superset-by-name+col_type match).
// `phone` is read opportunistically from whatever the bound table actually has — query
// returns every column of the real table regardless of what we declared here.
declareTables([{
  key: "members",
  title: "Members",
  description: "People and their roles — shared with the Member Manager frame.",
  schema: [
    { name: "name",  col_type: "text", nullable: false },
    { name: "email", col_type: "text", nullable: false },
    { name: "role",  col_type: "text", nullable: false },
  ],
}]);

// ----- Per-sfi settings (local-only JSON file) ------------------------------------------
type Settings = {
  title: string;
  allow_public_viewing: boolean;
  public_roles: string[]; // role(s) whose message history is exposed to anonymous viewers
};

const DEFAULT_SETTINGS: Settings = {
  title: "Reachout",
  allow_public_viewing: false,
  public_roles: [],
};

const allSettings: Record<string, Settings> = loadJsonFile(import.meta.url, "settings.json", {} as Record<string, Settings>);

function getSettings(sfi_id: string): Settings {
  const s = allSettings[sfi_id];
  if (!s) return { ...DEFAULT_SETTINGS, public_roles: [] };
  return {
    title: typeof s.title === "string" && s.title.trim() ? s.title : DEFAULT_SETTINGS.title,
    allow_public_viewing: !!s.allow_public_viewing,
    public_roles: Array.isArray(s.public_roles) ? s.public_roles.map(String) : [],
  };
}

function setSettings(sfi_id: string, next: Settings): void {
  allSettings[sfi_id] = next;
  saveJsonFile(import.meta.url, "settings.json", allSettings);
}

// ----- Sent-message log (local-only JSON file, keyed by sfi_id) -------------------------
type SentEntry = {
  id: string;
  sent_at_ms: number;
  to_all: boolean;
  roles: string[];          // empty when to_all
  method: "email" | "text";
  subject: string;          // email only; "" otherwise
  message: string;
  recipient_count: number;  // how many people the audience resolved to at send time
  attempted_count: number;  // text only: how many were actually tapped (== recipient_count for email)
};

const allLogs: Record<string, SentEntry[]> = loadJsonFile(import.meta.url, "sent_log.json", {} as Record<string, SentEntry[]>);

function getLog(sfi_id: string): SentEntry[] {
  const l = allLogs[sfi_id];
  return Array.isArray(l) ? l : [];
}

function saveLog(sfi_id: string, entries: SentEntry[]): void {
  allLogs[sfi_id] = entries;
  saveJsonFile(import.meta.url, "sent_log.json", allLogs);
}

// ----- Roster helpers -------------------------------------------------------------------
type Member = { name: string; email: string; role: string; phone: string };

async function loadMembers(sfi_id: string): Promise<Member[]> {
  const { rows } = await table("members", sfi_id).query({ limit: 5000 });
  return rows.map((r: Record<string, unknown>) => ({
    name: typeof r.name === "string" ? r.name : String(r.name ?? ""),
    email: typeof r.email === "string" ? r.email : String(r.email ?? ""),
    role: typeof r.role === "string" ? r.role : String(r.role ?? ""),
    phone: typeof r.phone === "string" ? r.phone.trim() : "",
  })).filter((m) => m.name || m.email);
}

// Distinct roles present in the roster, with a count and whether every member in that role
// has a phone number (which is what unlocks the "Send as text" path for that audience).
type RoleInfo = { role: string; count: number; all_have_phone: boolean };

function summarizeRoles(members: Member[]): RoleInfo[] {
  const byRole = new Map<string, Member[]>();
  for (const m of members) {
    const r = m.role || "(no role)";
    if (!byRole.has(r)) byRole.set(r, []);
    byRole.get(r)!.push(m);
  }
  const out: RoleInfo[] = [];
  for (const [role, list] of byRole) {
    out.push({
      role,
      count: list.length,
      all_have_phone: list.length > 0 && list.every((m) => m.phone.length > 0),
    });
  }
  out.sort((a, b) => a.role.localeCompare(b.role, undefined, { sensitivity: "base" }));
  return out;
}

// Resolve an audience (everyone, or a set of roles) to the matching members, de-duplicated
// by email and sorted by name. Used by both the email and the text send paths.
function resolveRecipients(members: Member[], to_all: boolean, roles: string[]): Member[] {
  const roleSet = new Set(roles);
  const seen = new Set<string>();
  const out: Member[] = [];
  for (const m of members) {
    if (!to_all && !roleSet.has(m.role || "(no role)")) continue;
    const key = (m.email || m.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return out;
}

// An entry is visible to anonymous / non-member viewers only when public viewing is on AND
// the message was sent to specific role(s), every one of which the owner marked public.
// "Everyone" sends are never public — they may have reached private-role recipients.
function isEntryPublic(entry: SentEntry, settings: Settings): boolean {
  if (!settings.allow_public_viewing) return false;
  if (entry.to_all) return false;
  if (!entry.roles.length) return false;
  const pub = new Set(settings.public_roles);
  return entry.roles.every((r) => pub.has(r));
}

// Public/non-member projection: strip recipient counts down to coarse info, keep the message.
function publicEntry(e: SentEntry): Omit<SentEntry, "attempted_count"> {
  return {
    id: e.id,
    sent_at_ms: e.sent_at_ms,
    to_all: e.to_all,
    roles: e.roles,
    method: e.method,
    subject: e.subject,
    message: e.message,
    recipient_count: e.recipient_count,
  };
}

function newId(): string {
  return `s_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ----- HTTP handler ---------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  const tables = ensureTables(peer);
  if (!tables.ready) {
    if (reqPath === "/index.html") return renderWaitingForOwner(replyPort, peer);
    if (method === "GET") {
      return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
    }
    return jsonReply(replyPort, 503, { error: "table not yet bound", missing: tables.missingKeys });
  }

  const settings = getSettings(peer.sfi_id);
  const isEditor = peer.is_sfi_editor;
  const isMember = peer.is_sfi_member;

  // ---- State: who am I, what can I do, what roles exist --------------------------------
  if (reqPath === "/api/state" && method === "GET") {
    let roles: RoleInfo[] = [];
    if (isMember) {
      const members = await loadMembers(peer.sfi_id);
      roles = summarizeRoles(members);
    }
    return jsonReply(replyPort, 200, {
      settings,
      viewer: {
        user_name: peer.user_name || "anon",
        is_owner: peer.is_owner,
        is_anon: peer.is_anon,
        is_sfi_member: isMember,
        is_sfi_editor: isEditor,
        space_color: peer.space_color || "",
      },
      can_edit: isEditor,
      roles, // editors compose against this; non-members get [] (roster structure stays private)
    });
  }

  // ---- The sent-message backlog -------------------------------------------------------
  if (reqPath === "/api/log" && method === "GET") {
    const entries = getLog(peer.sfi_id).slice().sort((a, b) => b.sent_at_ms - a.sent_at_ms);
    if (isMember) {
      return jsonReply(replyPort, 200, { entries, can_edit: isEditor });
    }
    // Anonymous / non-member: only the publicly-exposed role messages, stripped down.
    if (!settings.allow_public_viewing) {
      return jsonReply(replyPort, 200, { entries: [], public_disabled: true });
    }
    const pub = entries.filter((e) => isEntryPublic(e, settings)).map(publicEntry);
    return jsonReply(replyPort, 200, { entries: pub, anon_view: true });
  }

  // ---- Resolve an audience to concrete recipients (editor only — exposes contacts) ----
  if (reqPath === "/api/resolve" && method === "POST") {
    if (!isEditor) return jsonReply(replyPort, 403, { error: "editors only" });
    const v = parseJsonBody<{ to_all?: unknown; roles?: unknown }>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    const to_all = !!v.to_all;
    const roles = Array.isArray(v.roles) ? v.roles.map((r) => sanitizeText(r, 80)).filter(Boolean) : [];
    if (!to_all && roles.length === 0) return jsonReply(replyPort, 400, { error: "pick an audience" });
    const members = await loadMembers(peer.sfi_id);
    const recipients = resolveRecipients(members, to_all, roles).map((m) => ({
      name: m.name, email: m.email, phone: m.phone,
    }));
    const all_have_phone = recipients.length > 0 && recipients.every((r) => r.phone.length > 0);
    return jsonReply(replyPort, 200, { recipients, all_have_phone });
  }

  // ---- Record a send into the local log (editor only) ---------------------------------
  if (reqPath === "/api/log" && method === "POST") {
    if (!isEditor) return jsonReply(replyPort, 403, { error: "editors only" });
    const v = parseJsonBody<{
      to_all?: unknown; roles?: unknown; method?: unknown;
      subject?: unknown; message?: unknown; recipient_count?: unknown; attempted_count?: unknown;
    }>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    const sendMethod = v.method === "text" ? "text" : "email";
    const to_all = !!v.to_all;
    const roles = Array.isArray(v.roles) ? v.roles.map((r) => sanitizeText(r, 80)).filter(Boolean) : [];
    const message = sanitizeText(v.message, 5000);
    const subject = sendMethod === "email" ? sanitizeText(v.subject, 200) : "";
    if (!message) return jsonReply(replyPort, 400, { error: "message required" });
    if (!to_all && roles.length === 0) return jsonReply(replyPort, 400, { error: "audience required" });
    const recipient_count = clampInt(Number(v.recipient_count) || 0, 0, 100000);
    const attempted_count = clampInt(Number(v.attempted_count ?? recipient_count) || 0, 0, recipient_count);
    const entry: SentEntry = {
      id: newId(),
      sent_at_ms: Date.now(),
      to_all,
      roles: to_all ? [] : roles,
      method: sendMethod,
      subject,
      message,
      recipient_count,
      attempted_count,
    };
    const entries = getLog(peer.sfi_id);
    entries.push(entry);
    saveLog(peer.sfi_id, entries);
    pushToInstance(peer.sfi_id, { type: "log_changed" });
    return jsonReply(replyPort, 200, { entry });
  }

  // ---- Delete a logged message (editor only) ------------------------------------------
  if (reqPath === "/api/log/delete" && method === "POST") {
    if (!isEditor) return jsonReply(replyPort, 403, { error: "editors only" });
    const v = parseJsonBody<{ id?: unknown }>(body);
    const id = String(v?.id ?? "");
    if (!id) return jsonReply(replyPort, 400, { error: "id required" });
    const entries = getLog(peer.sfi_id).filter((e) => e.id !== id);
    saveLog(peer.sfi_id, entries);
    pushToInstance(peer.sfi_id, { type: "log_changed" });
    return replyPort.postMessage({ status: 204, contentType: "text/plain", body: null });
  }

  // ---- Settings (owner only) ----------------------------------------------------------
  if (reqPath === "/api/settings" && method === "POST") {
    if (!peer.is_owner) return jsonReply(replyPort, 403, { error: "only the frame owner can change settings" });
    const v = parseJsonBody<{ title?: unknown; allow_public_viewing?: unknown; public_roles?: unknown }>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    const title = sanitizeText(v.title, 80) || DEFAULT_SETTINGS.title;
    const public_roles = Array.isArray(v.public_roles)
      ? Array.from(new Set(v.public_roles.map((r) => sanitizeText(r, 80)).filter(Boolean)))
      : [];
    const next: Settings = { title, allow_public_viewing: !!v.allow_public_viewing, public_roles };
    setSettings(peer.sfi_id, next);
    pushToInstance(peer.sfi_id, { type: "settings_changed" });
    return jsonReply(replyPort, 200, { settings: next });
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  return jsonReply(replyPort, 404, { error: "not found", path: reqPath });
};

log("Member Reachout frame is up and running.");
