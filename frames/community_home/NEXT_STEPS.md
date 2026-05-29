# Community Home — Next Steps

Ideas for extending this frame:

1. **Rich text / markdown sections** — Swap plain textareas for a minimal markdown editor (or a tiny contenteditable with bold/italic/link buttons) and render the output with a sanitized markdown parser so section bodies can include formatting, inline links, and lists.
2. **Hero image / logo** — Add an `uploads/` directory under `./data/` and let admins upload a logo + hero background image (size-capped, hashed filenames). Serve them back via a `/api/uploads/:id` endpoint and show them at the top of the public page.
3. **Drag-to-reorder** — Wire a tiny drag-and-drop handler on the `.ch-section-row` / `.ch-link-row` and POST the resulting id order to `/api/admin/sections/reorder` (the backend already supports it). Add the same for links.
4. **Announcement banner** — A dismissible pinned announcement with an expires-at date (shown until the viewer dismisses it or it expires) so communities can surface time-sensitive info without rewriting their page.
5. **Event / schedule section type** — Beyond free-form sections, add a "schedule" section whose body is structured (time, title, location) and renders as a compact list with relative-time badges ("in 2 days", "live now").
6. **Multi-admin edit indicators** — Broadcast transient `{ type: "ch_editing", user_name, field_key }` presence pings so concurrent admins can see who is currently editing what field (fade out after a few seconds).
7. **Page history / undo** — Snapshot the page JSON into a `page_history` table on every mutation; expose a small "recent changes" admin panel that lets admins roll the page back to a prior version.
