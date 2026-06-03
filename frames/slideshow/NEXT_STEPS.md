# Slideshow — next steps

Where this frame could grow:

- **Drag-to-reorder slides.** The filmstrip reorders via the ◀ ▶ slide-ops buttons today; pointer drag-and-drop on the thumbnails would be nicer once lists get long.
- **More shapes & line styling.** Rectangle / ellipse / line cover the basics. Arrows, polygons, stroke color/width on filled shapes, and rotation are natural extensions (every element already lives in the fixed logical-px coordinate space, so a `rotation` field would scale cleanly).
- **Snapping & alignment guides.** Snap element edges/centers to each other and to the slide thirds while dragging, with on-canvas guide lines. Geometry is already in logical px, so this is a frontend-only addition.
- **Inline text editing on the canvas.** Double-click currently opens the inspector textarea; a `contenteditable` overlay positioned inside the scaled stage would let authors type directly on the slide. Watch out: htm/Preact + `contenteditable` + the CSS `transform: scale()` interact awkwardly, which is why the inspector approach was chosen first.
- **Speaker notes & per-slide transitions.** A `notes` field per slide (shown only to the presenter) and a simple fade/slide transition between slides in present mode.
- **Export.** "Download as images / PDF" by rendering each slide stage to a canvas at full logical resolution.
- **Conflict-aware editing.** Saves are last-write-wins with a live `deck_changed` push; two editors dragging the same element at once can clobber. A per-element revision or operation-based merge would harden multi-editor sessions (still without a SyncTable — the JSON doc stays the source of truth).

## Host notes — uploads & images

**Uploads (frame-side).** Modeled on the `file_folder` frame: the image is validated to be an
image, resized client-side via a `<canvas>` so its longest edge is ≤ 2048 px (originals already
within limits and of a known type are uploaded untouched to preserve animated GIFs / PNG
transparency), then sent as an in-memory `ArrayBuffer` body — NOT a `File` object. WebKit reads
`File`/`Blob` bodies asynchronously and the `axum://` custom-scheme bridge captures the request
before that read finishes, so a `File` body arrives empty. The backend re-checks the extension,
byte size, and a magic-byte signature before writing.

**Image storage & GC.** Uploaded images live in `data/shows/<sfi_slug>/images/<uuid>.<ext>`
beside the deck's `show.json`. On every save, images no longer referenced by any element are
deleted — except files modified within the last 5 minutes, so an image uploaded just before its
element is saved isn't swept out from under a concurrent editor.

**Present mode & fullscreen.** Entering present mode attempts `requestFullscreen()` on the
document; if the sandboxed iframe isn't granted fullscreen it falls back to filling the frame
tile (`position: fixed; inset: 0`), so presenting works either way.
