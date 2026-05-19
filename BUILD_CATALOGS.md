# Building the catalog manifests

This repo serves a public **Tandem catalog**. A catalog is a JSON file listing installable frames or capabilities; a Tandem client fetches it, displays the items, and downloads + verifies a package on install.

There are two manifests:

- [`frames.json`](frames.json) — one entry per directory under [`frames/`](frames/).
- [`capabilities.json`](capabilities.json) — one entry per JSON file under [`capabilities/`](capabilities/). Not yet emitted; appears the first time you put a capability JSON in [`capabilities/`](capabilities/).

Both manifests are **generated artifacts**. Edit the source in [`frames/`](frames/) / [`capabilities/`](capabilities/), then re-run the build.

## Quick start

```sh
python3 scripts/build_catalogs.py
git add frames.json capabilities.json packages/ frames/ capabilities/
git commit -m "rebuild catalogs"
git push
```

The build script:

1. Walks [`frames/`](frames/). For each subdirectory that has a `frame.json` and does not start with `_` or `.`:
   - Builds a deterministic gzipped tarball at `packages/frames/<dir_id>.tar.gz`. Mtimes, uids, gids, and gzip header timestamps are all zeroed so rebuilds with no source changes produce byte-identical artifacts (stable sha256 across rebuilds).
   - Excludes `data/`, `.DS_Store`, `__pycache__`, and `.git` from each tarball. `data/` is per-host runtime state and is preserved separately by the Tandem installer.
   - Computes the sha256 of the tarball.
   - Reads `frame.json` and emits an entry in `frames.json` with `name`, `description`, `icon`, `modified_at`, the lightweight `frame_preview` (frame_type, default sizes, capability deps), a `package_url` pointing at the GitHub raw URL, and the recorded sha256.
2. Walks [`capabilities/`](capabilities/). For each `*.json` file (not starting with `_` or `.`):
   - Copies it as-is to `packages/capabilities/<name>.json` (capabilities ship as single JSON files, not tarballs).
   - Computes its sha256 and writes an entry in `capabilities.json` with a `capability_preview` carrying `kind` and method names.
3. Writes `frames.json` / `capabilities.json` at the repo root.

## Hosting

The Tandem client can fetch the manifest from any HTTPS URL. The default URLs assume the repo is hosted on GitHub at `smlcrft/tandem-catalogs` and served via `raw.githubusercontent.com`:

- Manifest: `https://raw.githubusercontent.com/smlcrft/tandem-catalogs/main/frames.json`
- Package:  `https://raw.githubusercontent.com/smlcrft/tandem-catalogs/main/packages/frames/<dir_id>.tar.gz`

If you fork this repo to another host, change `BASE_URL` near the top of [`scripts/build_catalogs.py`](scripts/build_catalogs.py) and rebuild. Both the manifest URL and every embedded `package_url` are derived from that single constant.

A Tandem user installs the catalog by entering the `frames.json` URL into the **Caps panel → Catalogs → Frame catalog URLs** (comma-separated, multiple allowed). The client then fetches the manifest, surfaces every item under Conjure, and downloads the matching `.tar.gz` on install — verifying the recorded sha256 before extracting.

## Manifest schema (wire format)

The build script emits this shape — it mirrors the `WireCatalogManifest` struct that the Tandem client deserializes (see `tauri-app/src-tauri/src/layer3_catalogs.rs` and `protocol.rs` in the Tandem app repo).

```jsonc
{
  "catalog_id":  "smlcrft_frames",        // stable id; rename = new catalog from the client's POV
  "name":        "Smlcrft Frames",
  "description": "Community frames published by smlcrft.",
  "kind":        "Frames",                // "Frames" | "Capabilities"
  "items": [
    {
      "kind":            "Frames",                       // matches the catalog kind
      "id":              "garden_gnome",                 // dir_id for frames, capability name for caps
      "name":            "Garden Gnome",
      "description":     "...",
      "icon":            "",                             // ph-* phosphor icon name, or empty
      "modified_at":     "2026-05-19T01:55:00Z",         // RFC 3339; drives "update available" detection
      "frame_preview": {                                 // null for capabilities
        "frame_type":               "Tandem",            // "Tandem" | "Solo" | "Hosted" | "Proxy"
        "default_width_px":         560,
        "default_height_px":        640,
        "depends_on_capabilities":  []
      },
      "capability_preview": null,                        // populated only for capability items
      "package_url":     "https://.../packages/frames/garden_gnome.tar.gz",
      "package_sha256":  "<64-char hex>"                 // required when package_url is set
    }
  ]
}
```

Capability items use `capability_preview` instead:

```jsonc
{
  "frame_preview": null,
  "capability_preview": {
    "kind":    "external_api",
    "methods": ["search", "summarize"]
  },
  "package_url":    "https://.../packages/capabilities/some_cap.json",
  "package_sha256": "<64-char hex>"
}
```

## Adding a new frame

1. Drop a directory under [`frames/`](frames/) containing at minimum `frame.json` and whatever code the frame needs (`frame.ts`, `public/`, etc.). Frame-authoring conventions live in the Tandem app's [`MANUAL_FRAMEGEN_CONTEXT.md`](https://github.com/smlcrft/tandem/blob/main/tauri-app/src-tauri/chassis/bundled_catalogs/frames/MANUAL_FRAMEGEN_CONTEXT.md).
2. Set `name`, `description`, `modified_at`, optional `default_width_px` / `default_height_px`, `permissions.net`, and `depends_on_capabilities` in `frame.json`. Bump `modified_at` whenever you ship a change you want existing installs to see as "update available".
3. Run `python3 scripts/build_catalogs.py`.
4. Commit `frames.json`, the new `frames/<dir_id>/`, and `packages/frames/<dir_id>.tar.gz`.

Names starting with `_` or `.` are skipped, so prefix any work-in-progress dirs with `_` to keep them out of the manifest.

## Adding a new capability

1. Drop `capabilities/<name>.json` describing the capability (same shape used in the Tandem app's `chassis/bundled_catalogs/capabilities/`).
2. Run `python3 scripts/build_catalogs.py`.
3. Commit `capabilities.json`, `capabilities/<name>.json`, and `packages/capabilities/<name>.json`.

## Updating an existing frame or capability

Edit the source in place, bump `modified_at` in the `frame.json` / capability JSON, re-run the build, commit. The client uses `modified_at` against the locally-installed copy's `modified_at` to decide whether to show an update affordance.

## What gets committed

- ✅ Sources: [`frames/`](frames/), [`capabilities/`](capabilities/).
- ✅ Generated manifests: `frames.json`, `capabilities.json`.
- ✅ Generated packages: `packages/frames/*.tar.gz`, `packages/capabilities/*.json`. These are what `package_url` points at, so they MUST be checked in (or hosted somewhere else — see "Hosting").
- ❌ Per-host runtime state: any `data/` subdir inside a frame. The build script skips these.

The build is deterministic, so a rebuild with no source changes produces no `git diff` — if you see one, something in the source actually changed (or the build script itself).

## Renaming or removing items

- **Renaming a `dir_id`**: this is a catalog-level rename. Existing installs won't auto-migrate — they'll just see the old item disappear and the new one appear. If preservation matters, keep the old `dir_id`.
- **Removing**: delete the source dir/file and the corresponding `packages/<...>` artifact, then rebuild. Existing installs will keep working but won't see updates and can't be reinstalled.

## Requirements

- Python 3.9+ (stdlib only — `tarfile`, `gzip`, `hashlib`, `json`, `pathlib`). No external packages.
