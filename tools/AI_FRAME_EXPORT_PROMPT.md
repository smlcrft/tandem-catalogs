# Repackage a web app as a Tandem frame — Self-Contained Context

**This document is complete on its own.** Everything you need to produce a valid Tandem
frame is written inline below — the skeleton files, the backend API, the manifest, and the
exact failure modes to avoid. You do **not** need to fetch any external repository, clone a
`_skeleton`, or read any other file. If you were handed this together with an existing web
app, follow **Part A** and you are done.

There are two paths:

- **Part A — Rebundle an existing static app (the common case).** You already have a built
  web app (React/Vue/Svelte/vanilla — anything that compiles to static `index.html` + JS +
  CSS + assets). You wrap it, unchanged, in four tiny files and zip it. **You do not rewrite
  the app.** Start here.
- **Part B — Author a new Tandem-native frame.** You are building UI from scratch and want
  Tandem's batteries (Preact + htm, live multiplayer SyncTables, identity gating). This is
  the reference material in Sections 5–9. Only needed if the app needs a backend or
  real-time collaboration.

---

## Part A — Rebundle an existing static app

### A.0 The deliverable

A single folder named `tandem-frame/`, zipped to `tandem-frame.zip`, with exactly this
shape:

```
tandem-frame/
  frame.json          ← manifest (≈12 lines, copy from A.1)
  frame.ts            ← static-file server (≈20 lines, copy from A.2)
  public/             ← your built app goes here, untouched
    index.html
    assets/…          ← your JS/CSS/images/fonts
    …
```

No `deno.json`. No `node_modules`. No build step inside the frame. No `data/` directory
(that is created at runtime on the user's device — never ship it). The frame's backend
(`frame.ts`) does exactly one thing: serve the files in `public/` over HTTP. Your app runs
inside a sandboxed iframe exactly as it did before — same HTML, same JS bundle, same CSS.

### A.1 `frame.json` — copy this verbatim, fill the three blanks

```json
{
  "name": "My App",
  "description": "One sentence describing what this app does for the user.",
  "frame_type": "Tandem",
  "app_version_min": "0.1.7",
  "permissions": { "net": [] },
  "created_at": "2026-01-01T00:00:00Z",
  "modified_at": "2026-01-01T00:00:00Z",
  "depends_on_capabilities": []
}
```

- `name` / `description` — human-facing; fill them in.
- `frame_type` — leave as `"Tandem"`.
- `permissions.net` — **list every external hostname your app calls at runtime.** A purely
  self-contained app keeps this empty (`[]`). If your app fetches, say, `api.github.com`,
  you must write `"net": ["api.github.com"]` or those calls are blocked by the sandbox. List
  bare hostnames, no scheme, no path. (CDN-hosted scripts/fonts loaded from HTML count too —
  but prefer to **vendor** them into `public/` so the frame is offline-capable; see A.5.)
- `created_at` / `modified_at` — any valid ISO-8601 timestamps.

### A.2 `frame.ts` — copy this verbatim, no edits needed

This is the entire backend. It serves files from `public/`, maps `/` to `index.html`, and
falls back to `index.html` for client-side routes so a single-page app's router keeps
working. Forwarding `headers` enables `If-Modified-Since` → `304` short-circuits.

```ts
import { serveFileAtPath } from "@frame-core";

self.onNetworkRequest = async function (replyPort, reqPath, method, headers, _query, _body, _cookies) {
  if (method !== "GET") {
    return replyPort.postMessage({
      status: 405,
      contentType: "application/json",
      body: JSON.stringify({ error: "method not allowed" }),
    });
  }

  // Bare "/" → the app shell.
  let p = reqPath === "/" ? "/index.html" : reqPath;

  // SPA fallback: a path with no file extension (e.g. "/about", "/dashboard/42")
  // is a client-side route, not a real file — serve index.html so the
  // front-end router takes over. Anything WITH an extension (.js/.css/.png/…)
  // is served straight from disk.
  const looksLikeFile = /\.[a-zA-Z0-9]+$/.test(p);
  if (!looksLikeFile) p = "/index.html";

  return serveFileAtPath(replyPort, new URL("./public" + p, import.meta.url), headers);
};
```

`@frame-core` resolves automatically — it is provided by the Tandem host at runtime. **Do
not** create a `deno.json`, `package.json`, or import map for it; doing so will break the
build. The import string is literally `"@frame-core"`.

### A.3 ⚠️ THE #1 FAILURE: asset paths must be RELATIVE

This is the single most common reason a rebundled app shows a blank screen, unstyled HTML,
or "elements in the wrong place." **Read it carefully.**

A Tandem frame is served under a per-placement URL **prefix**, not at the web root. So a
build that emits **absolute** asset URLs breaks:

```html
<!-- ❌ BROKEN: Vite/CRA/Webpack default output. Absolute paths resolve to the
     chassis root, NOT your frame's public/ dir — every asset 404s. -->
<script type="module" src="/assets/index-a1b2c3.js"></script>
<link rel="stylesheet" href="/assets/index-d4e5f6.css">
```

```html
<!-- ✅ CORRECT: relative paths resolve under the frame's URL prefix. -->
<script type="module" src="./assets/index-a1b2c3.js"></script>
<link rel="stylesheet" href="./assets/index-d4e5f6.css">
```

**Fix it at build time (preferred), then re-run the build:**

| Tool | Setting |
| ---- | ------- |
| **Vite** | `base: './'` in `vite.config.js` (the default is `'/'`) |
| **Create React App** | `"homepage": "."` in `package.json` |
| **Next.js (static export)** | `assetPrefix: '.'` and `images.unoptimized: true` |
| **Angular** | `ng build --base-href ./` |
| **Parcel** | `parcel build --public-url ./` |

**If you cannot re-run the build**, edit the emitted `public/index.html` directly: change
every leading-slash asset URL (`/assets/…`, `/static/…`, `src="/…"`, `href="/…"`) to start
with `./` instead. Do this for `<script>`, `<link>`, `<img>`, and any inline references.

> A `<base href="./">` tag does **not** fix this — a `<base>` tag has no effect on URLs that
> already start with `/`. You must change the leading `/` to `./`. Only add `<base href="./">`
> if your app loads assets via paths that are already relative-without-a-dot (rare).

If your bundle hardcodes absolute asset URLs **inside the JS** (some frameworks inline an
`import.meta.env.BASE_URL` or a publicPath constant), the build-time settings above are the
only reliable fix — rebuild with the relative base.

### A.4 ⚠️ THE #2 FAILURE: a single-page app must use HASH-based routing

This is the most common reason a rebundled app loads but immediately shows its own **404 /
"page not found"** screen (even though every asset downloaded fine). **Read it carefully.**

A frame is served under a per-placement URL **prefix** that contains a per-install device
hash, e.g. `/frame/35ef…1716/my_app/index.html`. A **path-based** SPA router
(`BrowserRouter`, Vue Router `history` mode, SvelteKit/Angular default routing, etc.) reads
`window.location.pathname` — which is that whole prefixed path — tries to match it against
your app's routes (`/`, `/about`, …), matches nothing, and renders the app's catch-all
NotFound page. The tell-tale console line is the framework's own message, e.g.:

```text
404 Error: User attempted to access non-existent route: /frame/35ef…1716/my_app/index.html
```

That 404 comes from **inside your bundle**, not from Tandem. The fix is to make routing
independent of the path prefix by switching to a **hash router** (routes live after `#`,
which the prefix never touches):

| Framework | Change |
| --------- | ------ |
| **React Router** | `BrowserRouter` → `HashRouter` (`import { HashRouter } from "react-router-dom"`) |
| **Vue Router** | `createWebHistory()` → `createWebHashHistory()` |
| **Angular** | `RouterModule.forRoot(routes, { useHash: true })` |
| **SvelteKit** | use the static adapter with a hash-based fallback, or a hash-router approach |
| **TanStack Router** | `createHashHistory()` |

Make this change in the app **source**, then rebuild and re-copy `dist/` into `public/`. A
hash router needs no `basename` and works no matter what prefix the frame is mounted under
(the prefix's device hash is unknowable at build time, so `basename` is not a reliable
alternative). After the switch, loading `…/index.html` (no `#`) resolves to your `/` route.

If the app has **no client-side router** (a plain static page, or a single-view app), there
is nothing to do here — skip this step.

### A.5 Other rebundling rules

- **Self-contained beats CDN.** If `index.html` pulls scripts/fonts/styles from a CDN
  (`https://cdn…`), either (a) vendor those files into `public/` and rewrite the links to
  `./…`, or (b) add the CDN hostname to `permissions.net`. Vendoring is strongly preferred —
  the frame then works offline and on every peer device.
- **External API calls need `permissions.net`.** The sandbox blocks any `fetch()` to a host
  not listed. Add each hostname (see A.1). Calls to your *own* assets (relative paths) are
  always fine and need no permission.
- **Don't rewrite the app.** You are repackaging, not porting. Keep the existing JS bundle,
  CSS, and HTML. Do not introduce Preact/htm/framelib (Part B) — that's for new frames.
- **"Consolidate to fewer files" means inline small assets, not rewrite logic.** If the app
  is already a tidy `index.html` + a couple of bundle files, leave it. Only inline a tiny
  CSS or JS file into `index.html` if it genuinely simplifies the tree. Never flatten a
  hashed production bundle by hand.
- **No `data/`, no `.DS_Store`, no `node_modules`** in the zip.
- **The iframe sandbox** is `allow-scripts allow-forms allow-modals` with **no**
  `allow-same-origin`. Consequences: `localStorage`/`sessionStorage`/cookies are unavailable
  (storage is "opaque origin"); `window.top` navigation is blocked. If the app depends on
  `localStorage` for persistence it will run but lose state on reload — that's acceptable for
  a first rebundle; wire Part B's persistence later if needed.

### A.6 Zip it (and verify the root control files survive)

> ⚠️ **THE #3 FAILURE: `frame.ts` / `frame.json` get dropped from the zip.** AI app builders
> package the *web app* — their export captures `public/` (the app's own files) but silently
> omits sibling files at the frame root that aren't recognized as part of the web build. The
> result is a zip with everything **except** `frame.ts` and `frame.json` — which makes the
> frame fail to load. Two rules prevent this:
>
> 1. **`tandem-frame/` must be a plain folder, NOT the web-app project.** Do not write the
>    control files into the Vite/React project root and rely on the builder's "Download"
>    button. Instead: build the app, copy its output into `tandem-frame/public/`, write
>    `frame.json` + `frame.ts` into `tandem-frame/`, and zip that folder directly with the
>    `zip` command below — no build tooling in the loop.
> 2. **Verify the archive lists the control files before delivering.** If they're missing, the
>    export dropped them — rebuild from a plain directory.

From the directory that *contains* `tandem-frame/`:

```sh
# 1. Confirm the root control files exist on disk first.
ls -la tandem-frame/frame.json tandem-frame/frame.ts

# 2. Zip the whole folder.
zip -r tandem-frame.zip tandem-frame \
  -x '*/data/*' -x '*.DS_Store' -x '*/node_modules/*'

# 3. Assert the control files made it into the archive (must print both lines).
unzip -l tandem-frame.zip | grep -E 'tandem-frame/frame\.(ts|json)$'
```

The full listing should show `tandem-frame/frame.json`, `tandem-frame/frame.ts`, and
`tandem-frame/public/index.html` plus all assets:

```sh
unzip -l tandem-frame.zip
```

If step 3 prints nothing, the zip is **invalid** — the control files were omitted. Recreate
`tandem-frame/` as a plain directory (not inside the app project), re-copy the files, and zip
again. That verified archive is the single-file deliverable. **Part A is complete.**

---

## Part B — Author a new Tandem-native frame

Everything below is reference material for building a frame's UI and backend *from scratch*
with Tandem's native toolkit. You do **not** need any of it to rebundle an existing app
(Part A). Reach for it when the frame needs a real backend, persistence, or live multiplayer.

### 1. What a frame is

A **frame** is a sandboxed micro-app that runs inside a Tandem Space — a tile on the canvas
with its own UI. Under the hood:

- **Backend** (`frame.ts`) — a Deno worker spawned by the Arbiter. Receives HTTP-style
  requests via `self.onNetworkRequest`. Imports from `"@frame-core"`.
- **Frontend** (`public/index.html` + static assets) — served into a sandboxed iframe
  (`allow-scripts allow-forms allow-modals`, no `allow-same-origin`). Talks to the backend
  over HTTP and to the OS via `window.postMessage`.
- **Identity cookies** — every backend request carries `device_id`, `user_id`, `sfi_id`,
  `cap_token`, `is_anon`, `is_owner`, `is_sfi_member`, `is_sfi_editor`, `space_id`,
  `user_name`, `space_color`. Parse with `parsePeerInfo` (Section 5).
- **Lifecycle** — one Deno worker per frame, one HTTP request per UI action, no persistent
  connection. State that must survive a reload has to be persisted (Section 7).

### 2. The canonical minimal frame (inline skeleton)

This is the smallest valid native frame, reproduced **in full** so you can copy it directly.
Three files. (For a rebundle, prefer the simpler `frame.ts` in A.2.)

**`frame.json`**

```json
{
  "name": "Skeleton",
  "description": "Foundational starter frame. Demonstrates Preact + htm + framelib.",
  "frame_type": "Tandem",
  "app_version_min": "0.1.7",
  "permissions": { "net": [] },
  "created_at": "2026-05-15T18:00:00Z",
  "modified_at": "2026-05-22T14:16:13Z",
  "depends_on_capabilities": []
}
```

**`frame.ts`**

```ts
import { serveFileAtPath, jsonReply, parseJsonBody, parsePeerInfo } from "@frame-core";

self.onNetworkRequest = async function (replyPort, reqPath, method, headers, _query, body, _cookies) {
  // GET — serve files from public/.
  if (method === "GET" && !reqPath.startsWith("/api/")) {
    return serveFileAtPath(replyPort, new URL("./public" + reqPath, import.meta.url), headers);
  }

  // Sample peer-info endpoint — render owner-only UI / "you are anonymous" banners / etc.
  if (reqPath === "/api/whoami" && method === "GET") {
    const peer = parsePeerInfo(_query, _cookies);
    // parsePeerInfo converts the wire-format "1"/"0" cookies into real booleans,
    // so clients can use plain truthy checks (`if (me.is_sfi_editor)`).
    // is_sfi_member = user is in the space's user_permissions.
    // is_sfi_editor = member AND a role above Viewer (Contributor/Collaborator/Admin/Owner).
    // Gate read access on is_sfi_member; gate writes/mutations on is_sfi_editor.
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

  // Sample echo endpoint — POST { message } returns { you_said }. Replace with real handlers.
  if (reqPath === "/api/echo" && method === "POST") {
    const data = parseJsonBody<{ message?: string }>(body);
    return jsonReply(replyPort, 200, { you_said: data?.message ?? "" });
  }

  return jsonReply(replyPort, 404, { error: "not found", path: reqPath });
};
```

**`public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Skeleton</title>
  <link rel="stylesheet" href="dyn/frame-prefs.css"> <!-- Tandem design tokens; themed per placement -->
  <style>
    :root { --ch: var(--os-c4); }
    body { margin: 0; font-family: var(--os-font-sans, system-ui, sans-serif);
      background: var(--os-bg, #faf9f7); color: var(--os-text, #1a1a1a); }
    main { max-width: 640px; margin: 0 auto; padding: 32px 24px; }
    h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
    .row { display: flex; gap: 8px; align-items: center; margin-top: 16px; }
    input { flex: 1; padding: 8px 12px; border: 1px solid var(--os-border, #e4e1dc);
      border-radius: 6px; background: var(--os-bg); color: var(--os-text); font: inherit; }
    button { padding: 8px 14px; border: 1px solid var(--ch); border-radius: 6px;
      background: var(--ch); color: var(--ch-fg, white); font: inherit; cursor: pointer; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .card { margin-top: 24px; padding: 16px; border: 1px solid var(--os-border, #e4e1dc); border-radius: 8px; }
    pre { margin: 0; font-size: 13px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <script type="module">
    import { frame, html, render, useState, useEffect } from "/lib/js/framelib.js";

    function SkeletonApp() {
      const [peer, setPeer] = useState(null);
      const [message, setMessage] = useState("");
      const [echo, setEcho] = useState(null);
      const [busy, setBusy] = useState(false);

      useEffect(() => {
        frame.api("api/whoami").then(setPeer).catch(e => console.error(e));
      }, []);

      async function send() {
        if (!message.trim()) return;
        setBusy(true);
        try {
          const res = await frame.api("api/echo", { message });
          setEcho(res.you_said);
          setMessage("");
        } finally { setBusy(false); }
      }

      return html`
        <main>
          <h1>Skeleton</h1>
          <div class="row">
            <input type="text" placeholder="Type something…" value=${message}
              onInput=${e => setMessage(e.target.value)}
              onKeyDown=${e => e.key === "Enter" && send()} />
            <button onClick=${send} disabled=${busy || !message.trim()}>Send</button>
          </div>
          ${echo !== null && html`<div class="card"><pre>${echo}</pre></div>`}
          ${peer && html`<div class="card"><pre>${JSON.stringify(peer, null, 2)}</pre></div>`}
        </main>
      `;
    }
    render(html`<${SkeletonApp}/>`, document.body);
  </script>
</body>
</html>
```

### 3. The `@frame-core` backend API surface

`frame.ts` imports everything backend-side from `"@frame-core"` (provided by the host — no
`deno.json` needed). The complete public surface, grouped by purpose:

**Identity & request parsing**
- `parsePeerInfo(query, cookies) → PeerInfo` — returns `{device_id, user_id, sfi_id,
  cap_token, is_anon, is_owner, is_sfi_member, is_sfi_editor, space_id, user_name,
  space_color}`. The four `is_*` fields are **booleans**; everything else is a string.
  Cookies travel the wire as `"1"`/`"0"`/`""`; `parsePeerInfo` converts the `is_*` ones to
  booleans, so use plain truthy checks (`if (peer.is_sfi_editor) { ... }`).
  - `is_sfi_member` = true iff the user is in the space's `user_permissions`. `is_sfi_editor`
    = true iff a member AND a role above Viewer (Contributor / Collaborator / Admin / Owner).
    Gate "can you see this frame at all" on `is_sfi_member`; gate write/mutate on
    `is_sfi_editor`. `is_owner` gates frame-management; owners are always also editors.

**HTTP helpers**
- `serveFileAtPath(replyPort, urlOrPath, requestHeaders?)` — serves a static asset, sets
  content-type from extension, always emits `Last-Modified`. Pass the request `headers` (4th
  arg of `onNetworkRequest`) to enable `If-Modified-Since` → `304` short-circuits. Always
  forward `headers`.
- `serveHtmlShell(replyPort, htmlPath, { peer?, inlineCss?, inlineJs? })` — serves HTML with
  optional inlined CSS/JS and an injected `window.__peer = {...}` for server-stamped identity.
- `jsonReply(replyPort, status, data)` — JSON response.
- `parseJsonBody<T>(body) → T | null` — parse request body; returns `null` on bad JSON.
- `sanitizeText(v, max)` — coerce → trim → cap to `max` chars.
- `toIntOrNull(v)`, `clampInt(n, lo, hi)` — numeric helpers.

**Per-frame data dir (flat-file persistence)**
- `frameDataDir(import.meta.url) → string` — ensures and returns `<frame_root>/data/`.
- `loadJsonFile(import.meta.url, "x.json", fallback)` — sync JSON read with fallback.
- `saveJsonFile(import.meta.url, "x.json", data)` — sync JSON write (pretty-printed).
- `mkdirSync` and `path` are re-exported from `@std/path` / `node:fs`.

**Local SQLite (per-device, NOT peer-synced)**
- `DatabaseSync` re-exported from `node:sqlite`. Construct once at module top with
  `path.join(import.meta.dirname, "data", "your.sqlite")`.

**SyncTables (shared, peer-replicated)**
- `declareTables([{ key, title, description, schema: [{name, col_type, nullable?,
  default_val?}] }])` — at module top.
  - `col_type` is `"text" | "integer" | "real" | "blob"`. **NOT** `"string"` / `"number"` /
    `"boolean"`. Field names are `col_type`, `nullable`, `default_val` — **not** `type`,
    `required`, `default`.
- `ensureTables(peer) → { ready, byKey, missingKeys }` — call inside the handler, **one arg**.
  If `!ready` and owner, framecore auto-fires the binding modal; if `!ready` for a non-owner,
  serve `renderWaitingForOwner(replyPort, peer)` for `/index.html` and a 503 for API routes.
- `table(key, sfi_id) → { query, upsert, delete, onChange }` — valid only after
  `ensureTables(peer).ready === true`. Author always uses column **names**; framecore
  translates to `col_id`s internally.
- `wireTableChangeListener(tableKey, sfi_id, pushType)` — idempotent. Subscribes to onChange
  and pushes `{type: pushType}` to every viewer on any mutation (local OR remote-synced).
- `renderWaitingForOwner(replyPort, peer?)` — canned wait screen for non-owners.

**Capabilities (external services)**
- `invokeCapability(capability, method, params) → Promise<{success, status, result_json}>`
  — call a registered capability (AI provider, network fetch, etc.). Declare the dependency
  in `frame.json#depends_on_capabilities`.

**Realtime push to viewers**
- `pushToInstance(sfi_id, data)` — broadcasts to every observed viewer session of this
  placement. Frontend receives via `useFramePush` (Section 4) or a raw `message` listener.
- `onUiMessage(handler)` — register a handler for UI-originated direct messages (rare).

**Other**
- `log(msg)` — backend log; routed to the OS frame-log ring buffer.
- `osConfig` — `{ grid_min_px, frame_min_grid_w, frame_min_grid_h }` — read-only metadata.

### 4. The frontend (`framelib`)

The frame iframe imports framelib from the shared chassis path:
`import { ... } from "/lib/js/framelib.js"`. The chassis serves it; frames must **not** carry
a local `public/framelib.js`. (This is for new UI only — a rebundled app keeps its own JS.)

**Preact + hooks + htm:** `h`, `render`, `Component`, `Fragment`, `createContext`; the full
hooks set (`useState`, `useEffect`, `useMemo`, `useRef`, `useReducer`, `useCallback`,
`useContext`, `useLayoutEffect`, `useId`, `useImperativeHandle`, `useErrorBoundary`); and
`html` — the htm tag bound to Preact's `h`, used as `` html`<div>${value}</div>` ``.

**HTTP (`frame.*`):** paths resolve under the iframe's URL prefix; NEVER use raw `fetch()`.
- `frame.api(path)` — GET, returns parsed JSON. `frame.api(path, body)` — POST JSON.
  `frame.api(path, body, "PUT"|"DELETE"|…)` — explicit method. `frame.api(path, null,
  "DELETE")` — DELETE no body.
- Auto-forwards `?sfi=` from the iframe URL on every call (don't roll your own wrapper). On
  non-2xx, throws an `Error` with `.status` and `.body` set.
- `frame.apiSafe(path, body?, method?)` — returns the `WAITING` sentinel on HTTP 503 instead
  of throwing (use when the backend may not be ready, e.g. SyncTable awaiting owner binding).
- `frame.fetch(path, options)` — escape hatch for raw fetch (binary, streaming).

**Open a link in the user's browser:** frames are sandboxed and can't open windows.
- `frame.openExternalUrl(url)` — opens in the OS browser (desktop) or a new tab (web). Host
  validates the scheme (`https`/`http`/`mailto`/`tel`) and asks the user to confirm. Use for
  genuine outbound links, NOT in-frame navigation.

**Async dialogs:** Tauri's webview doesn't reliably surface native `alert`/`confirm`/`prompt`.
- `await frame.alert(msg, { title?, okLabel? })`, `await frame.confirm(msg, { title?, danger?,
  okLabel?, cancelLabel? })` → `true`/`false`, `await frame.prompt(msg, { title?,
  defaultValue?, placeholder?, type?, okLabel?, cancelLabel? })` → string or `null`. Callers
  must be `async`.

**UI primitives (named exports):** `<Editable value=… onSave=… tag="input"|"textarea" />`
(save-on-blur, resists clobbering by peer pushes), `<Overlay onClose=…>`, `<Modal title=…
onClose=… actions=…>`, `<WaitingForOwner />`.

**Hooks (custom):** `useFramePush({ event_type: handler, … })` — single subscriber for
`pushToInstance` messages, dispatched by `data.type`. Replaces ad-hoc
`window.addEventListener("message", …)`.

**Color binding:** `applyChannel(el, peer.space_color)` — parses `var(--os-cN)` (c1–c12) or
`#hex` (falls back to `c1`) and sets `--ch` + `--ch-fg` on `el`. Call once on the root early
in mount; descendant CSS reads `var(--ch)` / `var(--ch-fg)`.

**Backend → frontend push.** Backend calls `pushToInstance(sfi_id, { type: "my_event", … })`;
listen with `useFramePush({ my_event: (data) => { /* refetch */ } })`. After your own
mutations, self-refresh directly in the handler too — the push is for *other* viewers; the
self-refresh makes the actor's UI feel instant. `pushToInstance` data must be
JSON-serialisable.

**Minimum boilerplate:**

```html
<script type="module">
  import {
    frame, html, render, useState, useEffect,
    Editable, Overlay, Modal, WaitingForOwner,
    useFramePush, applyChannel, WAITING,
  } from "/lib/js/framelib.js";

  const peer = window.__peer || {};

  function App() {
    const [data, setData] = useState(null);
    useEffect(() => {
      applyChannel(document.body, peer.space_color);
      frame.api("api/whoami").then(setData);
    }, []);
    useFramePush({ something_changed: () => frame.api("api/state").then(setData) });
    if (!data) return html`<div>Loading…</div>`;
    return html`<pre>${JSON.stringify(data, null, 2)}</pre>`;
  }
  render(html`<${App}/>`, document.body);
</script>
```

### 5. Identity parsing

Use `parsePeerInfo(query, cookies)` in any `/api/*` handler that needs to know who's calling
(see the `/api/whoami` example in Section 2). The `is_*` fields come back as **booleans** —
use plain truthy checks (`if (peer.is_owner)`), never `=== "1"`.

### 6. Privacy / identity gating

Three identity tiers. Owner is NOT a fourth tier — it's an editor with management
capabilities on top.

| Tier | Who | Render branch |
| ---- | --- | ------------- |
| **Anon / non-member** (`!peer.is_sfi_member`) | Anonymous link viewers AND signed-in users whose only access is a bookmark to this SFI. | Public read-only view (only if the frame publishes one). Backend rejects writes with 403. |
| **Viewer-role member** (`peer.is_sfi_member && !peer.is_sfi_editor`) | A space member the owner marked read-only. | Read-only UI — show data, hide/disable write controls. |
| **Editor** (`peer.is_sfi_editor`) | A member above Viewer (Contributor/Collaborator/Admin/Owner). | Full interactive UI. `peer.is_owner` is a refinement *inside* this tier: owners also get frame-management controls. |

Three render shapes:
- **`privacy-universal`** — everyone sees the same UI; don't branch on identity.
- **`privacy-space-users`** — gate the frame on `peer.is_sfi_member`; within members, split
  write controls on `peer.is_sfi_editor`.
- **`privacy-public-view`** — three-tier render: non-member read-only / viewer-member
  read-only / editor interactive. **Gate writes on `is_sfi_editor`, never on `is_sfi_member`**
  (otherwise Viewer-role members can mutate state).

### 7. Storage choices

**Hard rules** (learned from real failures):
- **Multiplayer (live across peers) requires SyncTable.** `DatabaseSync`/local SQLite is
  per-device and never syncs. Don't mix the two in one data domain.
- **`ensureTables(peer)` IS the auth gate for SyncTable endpoints.** Do not write your own
  `if (!peer.is_sfi_member) return 403` around them — it handles owner/member/anon correctly
  and a homemade gate breaks the public-view case and the warm-up handshake.
- **Schema field names are `col_type` / `nullable` / `default_val`** (not `type` / `required`
  / `default`); `col_type` values are `"text" | "integer" | "real" | "blob"`. Getting this
  wrong silently leaves the frame stuck on the binding modal.
- **Local SQLite paths use `path.join(import.meta.dirname, "data", "x.sqlite")`** with
  `mkdirSync(dataDir, { recursive: true })` at module top.

### 8. CSS & icons

Native frames inherit Tandem's design tokens by linking the relative path
`<link rel="stylesheet" href="dyn/frame-prefs.css">`. After that, CSS variables are
available: `--os-bg`, `--os-text`, `--os-fs-*`, `--os-sp-*`, `--os-radius-*`, `--os-c1`…
`--os-c12`, `--os-font-sans`, `--os-font-mono`, `--os-ease-spring`, etc. Set the frame's
accent at the top of `:root`: `:root { --ch: var(--os-c4); }`. Phosphor Light icons:
`<i class="ph-light ph-<name>"></i>`. (A rebundled app keeps its own CSS — this is optional.)

### 9. `frame.json` manifest reference

Minimum is shown in A.1 and Section 2. Field notes:
- `frame_type` — almost always `"Tandem"` (sandboxed Deno worker). `Solo`/`Hosted`/`Proxy`
  are advanced.
- `permissions.net` — array of bare hostnames the worker may fetch from. Empty for
  self-contained frames; e.g. `["api.open-meteo.com", "geocoding-api.open-meteo.com"]`.
- `default_width_px` / `default_height_px` — optional initial tile size in pixels.
- `depends_on_capabilities` — capability names this frame requires.
- `created_at` / `modified_at` — ISO-8601. Bump `modified_at` to signal an update to
  existing installs.

---

## Common issues (read once before generating)

**Rebundling (Part A):**
- **Absolute asset paths break.** `/assets/x.js` → 404 under the frame prefix. Use `./assets/x.js`
  (build with a relative base — see A.3). This is the #1 cause of blank/unstyled/misplaced output.
- **Path-based SPA routers render a 404.** `BrowserRouter`/history-mode routing reads the
  prefixed `location.pathname` and matches nothing. Use a hash router — see A.4.
- **External hosts need `permissions.net`.** Any `fetch()` to a host not listed is blocked.
- **No `localStorage`/cookies** — the iframe has no `allow-same-origin` (opaque origin).
- **Root files get dropped from the zip.** AI builders export only the web app, omitting
  sibling `frame.ts`/`frame.json`. Build `tandem-frame/` as a standalone folder and verify the
  archive lists both control files — see A.6.
- **Don't ship `data/`, `node_modules`, or `.DS_Store`** in the zip.
- **Don't create a `deno.json`** — `@frame-core` is host-provided.

**Native authoring (Part B):**
- **`peer.is_*` are booleans** after `parsePeerInfo` — use truthy checks, not `=== "1"`.
- **Never call raw `fetch()` in frontend code** — use `frame.api` / `frame.fetch` (the iframe
  runs under a URL prefix; raw fetch hits the wrong origin).
- **SyncTable schema field names** are `col_type` / `nullable` / `default_val`, types
  `"text" | "integer" | "real" | "blob"`.
- **Don't homebrew an auth check around SyncTable endpoints** — `ensureTables(peer)` is the gate.
- **`ensureTables(peer)` takes one arg.**
- **Local SQLite does NOT sync** — multiplayer requires SyncTable. Don't mix them in one domain.
- **`status ∈ {101, 103, 204, 205, 304}` responses must have `body: null`** — `body: ""`
  crashes the arbiter with `"Response with null body status cannot have body"`.
- **`pushToInstance` data must be JSON-serialisable.**
- **`/api/...` is the convention for backend routes**; static assets serve from `public/`.
- **`import.meta.dirname` vs `import.meta.url`** — `dirname` for filesystem paths (with
  `path.join`); `url` for `new URL("./public/...", import.meta.url)` and for
  `loadJsonFile` / `saveJsonFile` / `frameDataDir`.

---

# PROMPT — use the context above to run this request

I have an existing web app. Repackage it to run as a Tandem frame by following **Part A**
above:

1. Create a folder named `tandem-frame/` as a **plain, standalone directory — NOT inside the
   web-app project.** (If it lives inside the app project, the builder's export will drop the
   root-level `frame.ts`/`frame.json`; see A.6.)
2. Put my app's built static files (the contents of its `dist/` / `build/` output —
   `index.html`, JS, CSS, assets) into `tandem-frame/public/`, **unchanged**.
3. Add `tandem-frame/frame.json` (copy from A.1; fill in `name`, `description`, and any
   external hostnames the app calls under `permissions.net`).
4. Add `tandem-frame/frame.ts` (copy verbatim from A.2 — the static-file server).
5. **Fix asset paths (A.3):** ensure every asset URL in `public/index.html` is **relative**
   (`./assets/…`), not absolute (`/assets/…`). If the app was built with Vite/CRA/etc.,
   either rebuild with a relative base or edit the emitted `index.html` to change leading-`/`
   asset URLs to `./`.
6. **Fix client-side routing (A.4):** if the app uses a path-based SPA router
   (`BrowserRouter`, Vue Router history mode, etc.), switch it to a **hash router**
   (`HashRouter`, `createWebHashHistory()`, etc.) in the source and rebuild — otherwise the
   app will load but immediately render its own 404 page under the frame's URL prefix. Skip
   if the app has no client-side router.
7. Do **not** rewrite the app in Preact/htm, and do **not** create a `deno.json`.
8. If there are included .js files (such as within `tandem-frame/public` or `tandem-frame/public/assets`), make sure that there are not assumed domains or blockers that will prohibit the code to run on a different domain, port, or protocol.
9. Zip the whole folder and **verify the root control files survived** (A.6):
   `zip -r tandem-frame.zip tandem-frame -x '*/data/*' -x '*.DS_Store' -x '*/node_modules/*'`,
   then run `unzip -l tandem-frame.zip | grep -E 'tandem-frame/frame\.(ts|json)$'` — it must
   print both `frame.ts` and `frame.json`. If it prints nothing, the export dropped them;
   rebuild the zip from the plain `tandem-frame/` directory.

Deliver `tandem-frame.zip`.
