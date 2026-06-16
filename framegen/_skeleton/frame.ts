// Skeleton frame — foundational starter for new Tandem frames.
//
// The model forks from this when generating a new frame. Keep it tiny and
// idiomatic; every line here will end up echoed across many generated frames.
//
// Two parts:
//   1. Frontend (public/index.html) — Preact + htm via framelib.
//   2. Backend (this file) — Deno worker. Default is "serve static files only";
//      add /api/* handlers below as your frame needs them.

import { serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo } from "@frame-core";

self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, _query, body, _cookies) {
  // GET — serve files from public/.
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }

  // Sample peer-info endpoint — useful from the frontend to render
  // owner-only UI / a "you are anonymous" banner / etc.
  if (reqPath === "/api/whoami" && method === "GET") {
    const peer = parsePeerInfo(_query, _cookies);
    // parsePeerInfo converts the wire-format "1"/"0" cookies into real booleans,
    // so /api/whoami can pass them straight through and clients can use plain
    // truthy checks (`if (me.is_sfi_editor)`) without any `=== "1"` ritual.
    // is_sfi_member is true iff the user is in the space's user_permissions;
    // is_sfi_editor is true iff they additionally hold a role above Viewer
    // (Contributor / Collaborator / Admin / Owner). Gate read access on
    // is_sfi_member; gate writes/mutations on is_sfi_editor so Viewer-role
    // members get a read-only experience.
    return jsonReply(replyPort, 200, {
      sfi_id:        peer.sfi_id,
      is_owner:      peer.is_owner,
      is_sfi_member: peer.is_sfi_member,
      is_sfi_editor: peer.is_sfi_editor,
      is_anon:       peer.is_anon,
      user_id:       peer.user_id,
      user_name:     peer.user_name,
    });
  }

  // Sample echo endpoint — POST { message } returns { you_said }. Replace
  // with your frame's actual handlers.
  if (reqPath === "/api/echo" && method === "POST") {
    const data = parseJsonBody<{ message?: string }>(body);
    return jsonReply(replyPort, 200, { you_said: data?.message ?? "" });
  }

  return jsonReply(replyPort, 404, { error: "not found", path: reqPath });
};
