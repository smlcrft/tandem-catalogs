// ----------------------------------------------------------------------------------------
// Member Manager — view and manage people and their roles within an organization.
//
// Members live in a shared SyncTable (peer-to-peer synced across the space).
// Per-placement preferences (org name, role list, owner-only edit toggle) are stored
// in a local JSON file keyed by sfi_id (space_frame_instance_id).
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, pushToInstance, parsePeerInfo,
  declareTables, ensureTables, table, renderWaitingForOwner,
  jsonReply, parseJsonBody, sanitizeText,
  loadJsonFile, saveJsonFile, wireTableChangeListener,
} from "@frame-core";

declareTables([{
  key: "members",
  title: "Members",
  description: "People and their roles within the organization.",
  schema: [
    { name: "name",  col_type: "text", nullable: false },
    { name: "email", col_type: "text", nullable: false },
    { name: "phone", col_type: "text", nullable: true },
    { name: "role",  col_type: "text", nullable: false },
  ],
}]);

// ----- Per-sfi preferences (local-only JSON file) ---------------------------------------
type Prefs = {
  org_name: string;
  roles: string[];
  owner_only_edit: boolean;
  allow_public_viewing: boolean;
};

const DEFAULT_PREFS: Prefs = {
  org_name: "Our Organization",
  roles: ["Owner", "Admin", "Member", "Guest"],
  owner_only_edit: false,
  allow_public_viewing: false,
};

const allPrefs: Record<string, Prefs> = loadJsonFile(import.meta.url, "prefs.json", {} as Record<string, Prefs>);

function getPrefs(sfi_id: string): Prefs {
  const p = allPrefs[sfi_id];
  if (!p) return { ...DEFAULT_PREFS, roles: [...DEFAULT_PREFS.roles] };
  return {
    org_name: typeof p.org_name === "string" ? p.org_name : DEFAULT_PREFS.org_name,
    roles: Array.isArray(p.roles) && p.roles.length > 0 ? p.roles.map(String) : [...DEFAULT_PREFS.roles],
    owner_only_edit: !!p.owner_only_edit,
    allow_public_viewing: !!p.allow_public_viewing,
  };
}

function setPrefs(sfi_id: string, next: Prefs): void {
  allPrefs[sfi_id] = next;
  saveJsonFile(import.meta.url, "prefs.json", allPrefs);
}

// ----- Helpers --------------------------------------------------------------------------
function canEdit(peer: ReturnType<typeof parsePeerInfo>, prefs: Prefs): boolean {
  if (peer.is_anon) return false;
  if (prefs.owner_only_edit) return peer.is_owner;
  return true;
}

// The `phone` column was added after the first release. Tables bound by an older
// version don't have it, so the owner (the binding owner) evolves the schema in place.
// Once added the binding map persists, so `"phone" in colMap` short-circuits this on
// every later request. Returns whether the column is available for this placement.
async function ensurePhoneColumn(
  peer: ReturnType<typeof parsePeerInfo>,
  colMap: Record<string, string>,
): Promise<boolean> {
  if ("phone" in colMap) return true;
  if (!peer.is_owner) return false; // only the binding owner can evolve the schema
  try {
    await table("members", peer.sfi_id).addColumn("phone", "text", { nullable: true });
    return true;
  } catch (e) {
    log("member_manager: failed to add phone column — " + e);
    return false;
  }
}

// ----- HTTP handler ---------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);

  const tables = ensureTables(peer);
  if (!tables.ready) {
    if (reqPath === "/index.html") {
      return renderWaitingForOwner(replyPort, peer);
    }
    if (method === "GET") { // static assets are fine to serve even if tables are not ready.
      return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
    }
    return jsonReply(replyPort, 503, { error: "table not yet bound", missing: tables.missingKeys });
  }

  wireTableChangeListener("members", peer.sfi_id, "members_changed");
  const members = table("members", peer.sfi_id);
  const prefs = getPrefs(peer.sfi_id);
  const editable = canEdit(peer, prefs);
  const hasPhone = await ensurePhoneColumn(peer, tables.byKey["members"].colIdByName);

  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, {
      prefs,
      viewer: {
        user_name: peer.user_name || "anon",
        is_owner: peer.is_owner,
        is_anon: peer.is_anon,
      },
      can_edit: editable,
      has_phone: hasPhone,
    });
  }

  if (reqPath === "/api/members" && method === "GET") {
    if (peer.is_anon && !prefs.allow_public_viewing) {
      return jsonReply(replyPort, 200, { rows: [], public_disabled: true });
    }
    const { rows } = await members.query({ limit: 1000 });
    // Group by role (in the configured role order), then alphabetically by name
    // within each role. Legacy/unknown roles sort to the end, then by name.
    const roleRank = new Map(prefs.roles.map((r, i) => [r, i]));
    const rankOf = (role: unknown) => roleRank.has(String(role)) ? roleRank.get(String(role))! : Number.MAX_SAFE_INTEGER;
    rows.sort((a, b) => {
      const ra = rankOf(a.role), rb = rankOf(b.role);
      if (ra !== rb) return ra - rb;
      return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
    });
    if (peer.is_anon) {
      // Public read-only view: name + role only — strip email and any other fields.
      const publicRows = rows.map((r: Record<string, unknown>) => ({
        _row_id: r._row_id,
        name: r.name,
        role: r.role,
      }));
      return jsonReply(replyPort, 200, { rows: publicRows, anon_view: true });
    }
    return jsonReply(replyPort, 200, { rows });
  }

  if (reqPath === "/api/member" && method === "POST") {
    if (!editable) return jsonReply(replyPort, 403, { error: "editing is restricted to the frame owner" });
    const v = parseJsonBody<{ row_id?: unknown; name?: unknown; email?: unknown; phone?: unknown; role?: unknown }>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    const name = sanitizeText(v.name, 120);
    const email = sanitizeText(v.email, 200);
    const phone = sanitizeText(v.phone, 40); // optional
    const role = sanitizeText(v.role, 80);
    if (!name) return jsonReply(replyPort, 400, { error: "name required" });
    if (!email) return jsonReply(replyPort, 400, { error: "email required" });
    if (!role) return jsonReply(replyPort, 400, { error: "role required" });
    if (!prefs.roles.includes(role)) return jsonReply(replyPort, 400, { error: "role not in allowed list" });
    const rowId = v.row_id ? String(v.row_id) : null;
    const values: Record<string, unknown> = { name, email, role };
    if (hasPhone) values.phone = phone; // only write phone once the column exists
    const { row_id } = await members.upsert(rowId, values);
    return jsonReply(replyPort, 200, { row_id });
  }

  if (reqPath === "/api/member/delete" && method === "POST") {
    if (!editable) return jsonReply(replyPort, 403, { error: "editing is restricted to the frame owner" });
    const v = parseJsonBody<{ row_id?: unknown }>(body);
    const rowId = String(v?.row_id ?? "");
    if (!rowId) return jsonReply(replyPort, 400, { error: "row_id required" });
    await members.delete(rowId);
    return replyPort.postMessage({ status: 204, contentType: "text/plain", body: null });
  }

  if (reqPath === "/api/settings" && method === "POST") {
    // Settings can always be edited by the owner; non-owners get blocked here regardless of owner_only_edit.
    if (!peer.is_owner) return jsonReply(replyPort, 403, { error: "only the frame owner can change settings" });
    const v = parseJsonBody<{ org_name?: unknown; roles?: unknown; owner_only_edit?: unknown; allow_public_viewing?: unknown }>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    const org_name = sanitizeText(v.org_name, 120) || DEFAULT_PREFS.org_name;
    const rolesIn: unknown[] = Array.isArray(v.roles) ? v.roles : [];
    const roles = Array.from(new Set(rolesIn.map((r: unknown) => sanitizeText(r, 80)).filter((r: string) => r.length > 0)));
    if (roles.length === 0) return jsonReply(replyPort, 400, { error: "at least one role is required" });
    const next: Prefs = {
      org_name,
      roles,
      owner_only_edit: !!v.owner_only_edit,
      allow_public_viewing: !!v.allow_public_viewing,
    };
    setPrefs(peer.sfi_id, next);
    pushToInstance(peer.sfi_id, { type: "settings_changed" });
    return jsonReply(replyPort, 200, { prefs: next });
  }

  if (method === "GET") {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }

  replyPort.postMessage({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }) });
};

log("Member Manager frame is up and running.");
