#!/usr/bin/env python3
"""
Build catalog manifests for tandem-catalogs.

Walks `frames/` and `capabilities/`, builds tarballs for frames (single-file
copies for capabilities) into `packages/`, computes sha256 of each package,
and emits `frames.json` / `capabilities.json` at the repo root. Those manifests
are what a Tandem client fetches when `catalog_urls_frames` /
`catalog_urls_capabilities` is configured.

Re-runnable. Idempotent: tarball entries are normalized (mtime=0, uid/gid=0,
empty uname/gname) so a rebuild with no source changes produces byte-identical
artifacts and a stable sha256.

Usage:
    python3 scripts/build_catalogs.py
"""
import gzip
import hashlib
import io
import json
import shutil
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT     = Path(__file__).resolve().parent.parent
FRAMES_DIR    = REPO_ROOT / "frames"
CAPS_DIR      = REPO_ROOT / "capabilities"
PACKAGES_DIR  = REPO_ROOT / "packages"
FRAMES_PKG    = PACKAGES_DIR / "frames"
CAPS_PKG      = PACKAGES_DIR / "capabilities"
FRAMES_OUT    = REPO_ROOT / "frames.json"
CAPS_OUT      = REPO_ROOT / "capabilities.json"

# Change this in one place when the hosting URL or branch changes.
BASE_URL = "https://raw.githubusercontent.com/smlcrft/tandem-catalogs/main"

# Catalog-level metadata (the wrapper around the items list).
CATALOG_FRAMES = {
    "catalog_id":  "smlcrft_frames",
    "name":        "Smlcrft Frames",
    "description": "Community frames published by smlcrft.",
}
CATALOG_CAPS = {
    "catalog_id":  "smlcrft_capabilities",
    "name":        "Smlcrft Capabilities",
    "description": "Community capabilities published by smlcrft.",
}

# Path-components to drop from frame tarballs. `data/` is per-host runtime
# state that the installer preserves separately; the rest is OS clutter.
EXCLUDE_PATH_PARTS = {"data", ".DS_Store", "__pycache__", ".git"}


# ---------------------------------------------------------------------------
# helpers

def sha256_hex(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def normalize_tarinfo(tarinfo: tarfile.TarInfo) -> tarfile.TarInfo | None:
    """Filter + normalize entries for deterministic, clean tarballs."""
    parts = Path(tarinfo.name).parts
    if any(p in EXCLUDE_PATH_PARTS for p in parts):
        return None
    tarinfo.mtime = 0
    tarinfo.uid = 0
    tarinfo.gid = 0
    tarinfo.uname = ""
    tarinfo.gname = ""
    return tarinfo


def build_frame_tarball(src_dir: Path, dest_tar: Path) -> None:
    dest_tar.parent.mkdir(parents=True, exist_ok=True)
    if dest_tar.exists():
        dest_tar.unlink()
    # Tarball layout: a single top-level dir named after `src_dir.name`,
    # holding `frame.json`, `frame.ts`, `public/`, etc. The installer
    # flattens single-top-level-dir tarballs, so this is the conventional
    # shape.
    #
    # Deterministic build: write the tar to a buffer, then gzip with mtime=0
    # and no embedded filename. tarfile.open("w:gz") would otherwise stamp
    # the current time into the gzip header and make rebuilds non-idempotent.
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        tar.add(src_dir, arcname=src_dir.name, filter=normalize_tarinfo)
    raw_tar = buf.getvalue()
    with open(dest_tar, "wb") as f:
        with gzip.GzipFile(filename="", mode="wb", fileobj=f, mtime=0, compresslevel=6) as gz:
            gz.write(raw_tar)


def stamp_iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def pick_modified_at(meta: dict) -> str:
    return meta.get("modified_at") or meta.get("created_at") or stamp_iso_utc_now()


# ---------------------------------------------------------------------------
# frames

def build_frames_manifest() -> int:
    if not FRAMES_DIR.exists():
        print("[frames] no frames/ dir — skipping")
        return 0
    items: list[dict] = []
    for sub in sorted(FRAMES_DIR.iterdir()):
        if not sub.is_dir():
            continue
        if sub.name.startswith("_") or sub.name.startswith("."):
            continue
        frame_json_path = sub / "frame.json"
        if not frame_json_path.exists():
            print(f"  ! skipping {sub.name}: missing frame.json")
            continue
        try:
            meta = json.loads(frame_json_path.read_text())
        except json.JSONDecodeError as e:
            print(f"  ! skipping {sub.name}: invalid frame.json ({e})")
            continue

        tar_path = FRAMES_PKG / f"{sub.name}.tar.gz"
        build_frame_tarball(sub, tar_path)
        sha = sha256_hex(tar_path)
        url = f"{BASE_URL}/packages/frames/{sub.name}.tar.gz"
        items.append({
            "kind":        "Frames",
            "id":          sub.name,
            "name":        meta.get("name", sub.name),
            "description": meta.get("description", ""),
            "icon":        meta.get("icon", ""),
            "modified_at": pick_modified_at(meta),
            "frame_preview": {
                "frame_type":              meta.get("frame_type", "Tandem"),
                "default_width_px":        meta.get("default_width_px", 0),
                "default_height_px":       meta.get("default_height_px", 0),
                "depends_on_capabilities": meta.get("depends_on_capabilities", []),
            },
            "capability_preview": None,
            "package_url":        url,
            "package_sha256":     sha,
        })
        print(f"  + {sub.name:30s}  {sha[:12]}…  ({tar_path.stat().st_size:>7} B)")

    manifest = {
        **CATALOG_FRAMES,
        "kind":  "Frames",
        "items": items,
    }
    FRAMES_OUT.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"[frames] wrote {FRAMES_OUT.name} with {len(items)} item(s)")
    return len(items)


# ---------------------------------------------------------------------------
# capabilities

def build_caps_manifest() -> int:
    if not CAPS_DIR.exists():
        print("[capabilities] no capabilities/ dir — skipping")
        return 0
    items: list[dict] = []
    for src in sorted(CAPS_DIR.iterdir()):
        if not src.is_file() or src.suffix != ".json":
            continue
        if src.name.startswith("_") or src.name.startswith("."):
            continue
        try:
            meta = json.loads(src.read_text())
        except json.JSONDecodeError as e:
            print(f"  ! skipping {src.name}: invalid JSON ({e})")
            continue

        CAPS_PKG.mkdir(parents=True, exist_ok=True)
        dest = CAPS_PKG / src.name
        shutil.copyfile(src, dest)
        sha = sha256_hex(dest)
        url = f"{BASE_URL}/packages/capabilities/{src.name}"
        items.append({
            "kind":        "Capabilities",
            "id":          meta.get("name", src.stem),
            "name":        meta.get("name", src.stem),
            "description": meta.get("description", ""),
            "icon":        meta.get("icon", ""),
            "modified_at": pick_modified_at(meta),
            "frame_preview": None,
            "capability_preview": {
                "kind":    str(meta.get("kind", "external_api")).lower(),
                "methods": [m.get("name", "") for m in meta.get("methods", []) if isinstance(m, dict)],
            },
            "package_url":    url,
            "package_sha256": sha,
        })
        print(f"  + {src.name:30s}  {sha[:12]}…")

    if not items:
        print("[capabilities] no capabilities present — capabilities.json not written")
        return 0

    manifest = {
        **CATALOG_CAPS,
        "kind":  "Capabilities",
        "items": items,
    }
    CAPS_OUT.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"[capabilities] wrote {CAPS_OUT.name} with {len(items)} item(s)")
    return len(items)


# ---------------------------------------------------------------------------
# main

def main() -> int:
    print(f"[build-catalogs] root = {REPO_ROOT}")
    n_frames = build_frames_manifest()
    n_caps   = build_caps_manifest()
    print(f"[build-catalogs] done — {n_frames} frame(s), {n_caps} capability(ies)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
