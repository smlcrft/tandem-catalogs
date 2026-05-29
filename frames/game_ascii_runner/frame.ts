import { log, serveFileAtPath } from "@frame-core";

self.onNetworkRequest = async (replyPort, path, method, _headers, _query, _body, _cookies) => {
  if (method === "GET") {
    await serveFileAtPath(replyPort, new URL("./public" + path, import.meta.url));
  } else {
    replyPort.postMessage({ status: 405, contentType: "application/json", body: JSON.stringify({ error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" }) });
  }
};

log("ASCII Runner frame loaded! Ready to play!");
