// ----------------------------------------------------------------------------------------
// Pancake Stacker — solo arcade game. Per-placement high score lives in a single JSON file
// keyed by sfi_id. Each viewer plays their own game (view-independent); the host device's
// high score is shared across whoever opens this placement, but no live cross-peer sync.
// ----------------------------------------------------------------------------------------
import {
  serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo,
  loadJsonFile, saveJsonFile, sanitizeText,
} from "@frame-core";

type HighScore = { high: number; updated_at: number; holder: string };
type Scores = Record<string, HighScore>;

const allScores: Scores = loadJsonFile(import.meta.url, "scores.json", {} as Scores);

function getScore(sfi_id: string): HighScore {
  return allScores[sfi_id] ?? { high: 0, updated_at: 0, holder: "" };
}

self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  const sfi = peer.sfi_id || "default";

  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  }

  if (reqPath === "/api/state" && method === "GET") {
    return jsonReply(replyPort, 200, {
      score: getScore(sfi),
      viewer: peer.user_name || "anon",
    });
  }

  if (reqPath === "/api/submit" && method === "POST") {
    const data = parseJsonBody<{ score?: unknown }>(body);
    const raw = Number(data?.score ?? 0);
    const candidate = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
    const current = getScore(sfi);
    let updated = current;
    const new_record = candidate > current.high;
    if (new_record) {
      updated = {
        high: candidate,
        updated_at: Date.now(),
        holder: sanitizeText(peer.user_name || "anon", 64),
      };
      allScores[sfi] = updated;
      saveJsonFile(import.meta.url, "scores.json", allScores);
    }
    return jsonReply(replyPort, 200, { score: updated, new_record });
  }

  return jsonReply(replyPort, 404, { error: "not found" });
};
