// ----------------------------------------------------------------------------------------
// Community Library — track community-owned items (books, tools, gear) and who has them
// checked out. Two SyncTables: a `members` roster (schema-compatible with Member Manager
// so they can share the same table) and a `library_assets` table for items + checkout info.
// Per-placement preferences (org name, allowed borrow durations, item types, edit policy)
// are stored in a local JSON file keyed by sfi_id.
// ----------------------------------------------------------------------------------------
import {
  log, serveFileAtPath, pushToInstance, parsePeerInfo,
  declareTables, ensureTables, table, renderWaitingForOwner,
  jsonReply, parseJsonBody, sanitizeText, toIntOrNull,
  loadJsonFile, saveJsonFile, wireTableChangeListener,
} from "@frame-core";

declareTables([
  {
    key: "members",
    title: "Members",
    description: "People in the organization. Compatible with the Member Manager frame so the same roster can be reused.",
    schema: [
      { name: "name",  col_type: "text", nullable: false },
      { name: "email", col_type: "text", nullable: false },
      { name: "role",  col_type: "text", nullable: false },
    ],
  },
  {
    key: "library_assets",
    title: "Library Assets",
    description: "Items the community shares, with current checkout status.",
    schema: [
      { name: "name",                    col_type: "text",    nullable: false },
      { name: "item_type",               col_type: "text",    nullable: false },
      { name: "checked_out_member_id",   col_type: "text",    nullable: true  },
      { name: "checked_out_manual_name", col_type: "text",    nullable: true  },
      { name: "checked_out_at",          col_type: "integer", nullable: true  },
      { name: "borrow_days",             col_type: "integer", nullable: true  },
      { name: "needs_attention",         col_type: "integer", nullable: false, default_val: "0" },
      { name: "notes",                   col_type: "text",    nullable: true  },
    ],
  },
]);

// ----- Per-sfi preferences (local-only JSON file) ---------------------------------------
type BorrowOption = { label: string; days: number };
type Prefs = {
  org_name: string;
  item_types: string[];
  borrow_options: BorrowOption[];
  default_borrow_days: number;
  owner_only_edit: boolean;
  allow_public_viewing: boolean;
};

const DEFAULT_PREFS: Prefs = {
  org_name: "Community Library",
  item_types: ["Book", "Tool", "Game", "Equipment", "Other"],
  borrow_options: [
    { label: "3 days",  days: 3  },
    { label: "1 week",  days: 7  },
    { label: "2 weeks", days: 14 },
    { label: "1 month", days: 30 },
  ],
  default_borrow_days: 7,
  owner_only_edit: false,
  allow_public_viewing: false,
};

const allPrefs: Record<string, Prefs> = loadJsonFile(import.meta.url, "prefs.json", {} as Record<string, Prefs>);

function clonePrefs(p: Prefs): Prefs {
  return {
    org_name: p.org_name,
    item_types: [...p.item_types],
    borrow_options: p.borrow_options.map((o) => ({ label: o.label, days: o.days })),
    default_borrow_days: p.default_borrow_days,
    owner_only_edit: p.owner_only_edit,
    allow_public_viewing: p.allow_public_viewing,
  };
}

function getPrefs(sfi_id: string): Prefs {
  const p = allPrefs[sfi_id];
  if (!p) return clonePrefs(DEFAULT_PREFS);
  const itemTypes = Array.isArray(p.item_types) && p.item_types.length > 0
    ? p.item_types.map(String) : [...DEFAULT_PREFS.item_types];
  const borrowOptions = Array.isArray(p.borrow_options) && p.borrow_options.length > 0
    ? p.borrow_options
        .map((o) => ({ label: String((o as BorrowOption).label ?? ""), days: Number((o as BorrowOption).days) }))
        .filter((o) => o.label && Number.isFinite(o.days) && o.days > 0)
    : [...DEFAULT_PREFS.borrow_options];
  return {
    org_name: typeof p.org_name === "string" && p.org_name ? p.org_name : DEFAULT_PREFS.org_name,
    item_types: itemTypes,
    borrow_options: borrowOptions.length > 0 ? borrowOptions : [...DEFAULT_PREFS.borrow_options],
    default_borrow_days: Number.isFinite(Number(p.default_borrow_days)) && Number(p.default_borrow_days) > 0
      ? Number(p.default_borrow_days)
      : (borrowOptions[0]?.days ?? DEFAULT_PREFS.default_borrow_days),
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

type AssetRow = Record<string, unknown> & { _row_id: string; _created_at: number };
type AssetStatus = "available" | "checked_out" | "overdue" | "issue";

function dueAt(checkedOutAt: number | null, borrowDays: number | null): number | null {
  if (!checkedOutAt || !borrowDays) return null;
  return checkedOutAt + borrowDays * 86400000;
}

function computeStatus(row: AssetRow, now: number): AssetStatus {
  if (Number(row.needs_attention) === 1) return "issue";
  const checkedOutAt = toIntOrNull(row.checked_out_at);
  const borrowDays = toIntOrNull(row.borrow_days);
  if (!checkedOutAt) return "available";
  const due = dueAt(checkedOutAt, borrowDays);
  if (due !== null && now > due) return "overdue";
  return "checked_out";
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
    return jsonReply(replyPort, 503, { error: "tables not yet bound", missing: tables.missingKeys });
  }

  wireTableChangeListener("library_assets", peer.sfi_id, "assets_changed");
  wireTableChangeListener("members",        peer.sfi_id, "members_changed");
  const assets = table("library_assets", peer.sfi_id);
  const members = table("members", peer.sfi_id);
  const prefs = getPrefs(peer.sfi_id);
  const editable = canEdit(peer, prefs);
  const now = Date.now();

  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, {
      prefs,
      viewer: {
        user_name: peer.user_name || "anon",
        is_owner: peer.is_owner,
        is_anon: peer.is_anon,
      },
      can_edit: editable,
      now,
    });
  }

  if (reqPath === "/api/members" && method === "GET") {
    if (peer.is_anon) return jsonReply(replyPort, 200, { rows: [] });
    const { rows } = await members.query({ limit: 1000 });
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const slim = rows.map((r: Record<string, unknown>) => ({
      _row_id: r._row_id, name: r.name, role: r.role,
    }));
    return jsonReply(replyPort, 200, { rows: slim });
  }

  if (reqPath === "/api/assets" && method === "GET") {
    if (peer.is_anon && !prefs.allow_public_viewing) {
      return jsonReply(replyPort, 200, { rows: [], public_disabled: true });
    }
    const { rows } = await assets.query({ limit: 2000 }) as { rows: AssetRow[] };
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    if (peer.is_anon) {
      // Anonymous: name, item_type, simple status. No member identities, no notes.
      const memberRows = (await members.query({ limit: 1000 })).rows as Record<string, unknown>[];
      const _memberById = new Map(memberRows.map((m) => [String(m._row_id), m]));
      const publicRows = rows.map((r) => {
        const status = computeStatus(r, now);
        const checkedOutAt = toIntOrNull(r.checked_out_at);
        const borrowDays = toIntOrNull(r.borrow_days);
        const due = dueAt(checkedOutAt, borrowDays);
        return {
          _row_id: r._row_id,
          name: r.name,
          item_type: r.item_type,
          status,
          due_at: due,
        };
      });
      return jsonReply(replyPort, 200, { rows: publicRows, anon_view: true });
    }

    // Authenticated: full data + computed status + resolved checkout names.
    const memberRows = (await members.query({ limit: 1000 })).rows as Record<string, unknown>[];
    const memberById = new Map(memberRows.map((m) => [String(m._row_id), m]));
    const enriched = rows.map((r) => {
      const status = computeStatus(r, now);
      const checkedOutAt = toIntOrNull(r.checked_out_at);
      const borrowDays = toIntOrNull(r.borrow_days);
      const memberId = String(r.checked_out_member_id ?? "");
      const member = memberId ? memberById.get(memberId) : undefined;
      return {
        _row_id: r._row_id,
        _created_at: r._created_at,
        name: r.name,
        item_type: r.item_type,
        checked_out_member_id: memberId,
        checked_out_member_name: member ? String(member.name) : "",
        checked_out_manual_name: String(r.checked_out_manual_name ?? ""),
        checked_out_at: checkedOutAt,
        borrow_days: borrowDays,
        due_at: dueAt(checkedOutAt, borrowDays),
        needs_attention: Number(r.needs_attention) === 1,
        notes: String(r.notes ?? ""),
        status,
      };
    });
    return jsonReply(replyPort, 200, { rows: enriched });
  }

  // ----- Mutations -----------------------------------------------------------------------
  if (!editable && method !== "GET") {
    // Settings has its own owner-only check below; everything else falls through to here.
    if (reqPath !== "/api/settings") {
      return jsonReply(replyPort, 403, { error: "editing is restricted" });
    }
  }

  if (reqPath === "/api/asset" && method === "POST") {
    const v = parseJsonBody<{ row_id?: unknown; name?: unknown; item_type?: unknown; notes?: unknown }>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    const name = sanitizeText(v.name, 200);
    const itemType = sanitizeText(v.item_type, 80);
    const notes = sanitizeText(v.notes, 1000);
    if (!name) return jsonReply(replyPort, 400, { error: "name required" });
    if (!itemType) return jsonReply(replyPort, 400, { error: "item_type required" });
    if (!prefs.item_types.includes(itemType)) return jsonReply(replyPort, 400, { error: "item_type not in allowed list" });
    const rowId = v.row_id ? String(v.row_id) : null;
    const { row_id } = await assets.upsert(rowId, {
      name, item_type: itemType, notes,
      ...(rowId ? {} : { needs_attention: 0 }),
    });
    return jsonReply(replyPort, 200, { row_id });
  }

  if (reqPath === "/api/asset/delete" && method === "POST") {
    const v = parseJsonBody<{ row_id?: unknown }>(body);
    const rowId = String(v?.row_id ?? "");
    if (!rowId) return jsonReply(replyPort, 400, { error: "row_id required" });
    await assets.delete(rowId);
    return replyPort.postMessage({ status: 204, contentType: "text/plain", body: null });
  }

  if (reqPath === "/api/asset/checkout" && method === "POST") {
    const v = parseJsonBody<{ row_id?: unknown; member_id?: unknown; manual_name?: unknown; borrow_days?: unknown; checked_out_at?: unknown }>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    const rowId = String(v.row_id ?? "");
    if (!rowId) return jsonReply(replyPort, 400, { error: "row_id required" });
    const memberId = sanitizeText(v.member_id, 100);
    const manualName = sanitizeText(v.manual_name, 200);
    if (!memberId && !manualName) return jsonReply(replyPort, 400, { error: "member_id or manual_name required" });
    const borrowDays = toIntOrNull(v.borrow_days) ?? prefs.default_borrow_days;
    const allowedDays = prefs.borrow_options.map((o) => o.days);
    if (!allowedDays.includes(borrowDays)) {
      return jsonReply(replyPort, 400, { error: "borrow_days not in allowed list" });
    }
    const checkedOutAt = toIntOrNull(v.checked_out_at) ?? now;
    await assets.upsert(rowId, {
      checked_out_member_id: memberId,
      checked_out_manual_name: memberId ? "" : manualName,
      checked_out_at: checkedOutAt,
      borrow_days: borrowDays,
    });
    return jsonReply(replyPort, 200, { row_id: rowId });
  }

  if (reqPath === "/api/asset/checkin" && method === "POST") {
    const v = parseJsonBody<{ row_id?: unknown }>(body);
    const rowId = String(v?.row_id ?? "");
    if (!rowId) return jsonReply(replyPort, 400, { error: "row_id required" });
    await assets.upsert(rowId, {
      checked_out_member_id: "",
      checked_out_manual_name: "",
      checked_out_at: null,
      borrow_days: null,
    });
    return jsonReply(replyPort, 200, { row_id: rowId });
  }

  if (reqPath === "/api/asset/attention" && method === "POST") {
    const v = parseJsonBody<{ row_id?: unknown; needs_attention?: unknown; notes?: unknown }>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    const rowId = String(v.row_id ?? "");
    if (!rowId) return jsonReply(replyPort, 400, { error: "row_id required" });
    const flag = v.needs_attention ? 1 : 0;
    const update: Record<string, unknown> = { needs_attention: flag };
    if (typeof v.notes !== "undefined") update.notes = sanitizeText(v.notes, 1000);
    await assets.upsert(rowId, update);
    return jsonReply(replyPort, 200, { row_id: rowId });
  }

  if (reqPath === "/api/settings" && method === "POST") {
    if (!peer.is_owner) return jsonReply(replyPort, 403, { error: "only the frame owner can change settings" });
    const v = parseJsonBody<{
      org_name?: unknown; item_types?: unknown; borrow_options?: unknown;
      default_borrow_days?: unknown; owner_only_edit?: unknown; allow_public_viewing?: unknown;
    }>(body);
    if (!v) return jsonReply(replyPort, 400, { error: "invalid JSON" });
    const org_name = sanitizeText(v.org_name, 120) || DEFAULT_PREFS.org_name;
    const itemTypesIn: unknown[] = Array.isArray(v.item_types) ? v.item_types : [];
    const item_types = Array.from(new Set(itemTypesIn.map((t: unknown) => sanitizeText(t, 80)).filter((t: string) => t.length > 0)));
    if (item_types.length === 0) return jsonReply(replyPort, 400, { error: "at least one item type is required" });
    const borrowIn: unknown[] = Array.isArray(v.borrow_options) ? v.borrow_options : [];
    const borrow_options = borrowIn
      .map((o: unknown) => ({ label: sanitizeText((o as BorrowOption).label, 40), days: toIntOrNull((o as BorrowOption).days) ?? 0 }))
      .filter((o: { label: string; days: number }) => o.label.length > 0 && o.days > 0);
    if (borrow_options.length === 0) return jsonReply(replyPort, 400, { error: "at least one borrow option is required" });
    const requestedDefault = toIntOrNull(v.default_borrow_days);
    const days = borrow_options.map((o) => o.days);
    const default_borrow_days = requestedDefault && days.includes(requestedDefault) ? requestedDefault : days[0];
    const next: Prefs = {
      org_name, item_types, borrow_options, default_borrow_days,
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

log("Community Library frame is up and running.");
