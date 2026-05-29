// ----------------------------------------------------------------------------------------
// HTTP API:
//   POST /api/roll   — roll for this placement; the result is pushed via BusFrameToUi to
//                      every live viewer of the placement (pushToInstance keyed by sfi_id).
//   GET  /api/state  — return the last roll for this placement { value, sides }
// ----------------------------------------------------------------------------------------
import { log, serveFileAtPath, pushToInstance, parsePeerInfo, jsonReply, loadJsonFile } from "@frame-core";
// --
const settings = { roll_time_ms: 1000, sides: 6, ...loadJsonFile<Partial<{ roll_time_ms: number; sides: number }>>(import.meta.url, "settings.json", {}) };
// --
const lastRoll = new Map<string, number>(); // Per-placement last-roll value (keyed by sfi_id).
// Perform a roll for a placement and push the animated result to every viewer of it.
function doRoll(sfi_id: string, sides: number): number {
  const value = Math.ceil(Math.random() * sides);
  if (sfi_id) {
    lastRoll.set(sfi_id, value);
    pushToInstance(sfi_id, { type: "rolled", value, sides, roll_time_ms: settings.roll_time_ms });
  }
  return value;
}
// -- HTTP routes --
self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, _body, cookies) {
  const peer = parsePeerInfo(query, cookies);
  if (reqPath === "/api/roll" && method === "POST") {
    doRoll(peer.sfi_id, settings.sides);
    replyPort.postMessage({ status: 204, contentType: "text/plain", body: null });
  } else if (reqPath === "/api/state" && method === "GET") {
    jsonReply(replyPort, 200, { value: lastRoll.get(peer.sfi_id) ?? 0, sides: settings.sides });
  } else if (method === "GET") {
    serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url));
  } else {
    replyPort.postMessage({ status: 404, body: JSON.stringify({ error: "Not found.", code: "NOT_FOUND" }), contentType: "application/json" });
  }
};
// --
log("Dice roller frame is up and running!");
