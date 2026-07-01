# Outpost — where it could grow next

Outpost is a lightweight public posting board: editors publish short posts (thought /
question / status / announcement, with optional media or a poll) and anyone with the
frame's share link reads them. State lives under `data/outposts/<sfi>/` — a per-placement
local SQLite database `posts.db` (posts / media rows / votes / prefs, indexed on
`created_ms`) plus a `<post_id>/` subfolder holding any attached media bytes.

Ideas, roughly in order of value:

- **Edit a post.** Today a post is publish-or-delete. An `/api/post/:id` PATCH that lets
  the author (or owner) revise text / kind, stamping an `edited_ms`, would be a small add.
- **Reactions.** The poll vote plumbing (per-voter key, anon device token, live push) is
  already a general "public reader interaction" primitive — a lightweight emoji reaction
  row per post could reuse it almost verbatim.
- **Search.** The feed now pages reverse-chronologically via a `created_ms` keyset cursor
  (`/api/state?limit=` for page one, `/api/posts?before=&limit=` for older pages, auto-loaded
  on scroll). The natural next step is a `posts_fts` FTS5 virtual table (or a `LIKE` filter)
  for full-text search across a large community's history, plus a `kind` filter chip.
- **Cursor ties.** Paging keys on `created_ms` alone; two posts sharing an exact millisecond
  could straddle a page boundary. If that ever matters, extend the cursor to `(created_ms, id)`.
- **Link previews.** URLs are auto-linked and open via the host's browser-confirm flow.
  A backend `permissions.net` fetch of OpenGraph tags could render a title/thumbnail card
  (see `_garden_plotter` for the net-permission + backend-`fetch` shape).
- **Feeds.** A read-only `/api/feed.json` (or RSS/Atom) endpoint would let the public link
  be followed by external readers, not just viewed in-frame.
- **Image handling.** Attachments are stored and served as-is. Server-side downscaling of
  large images (or generating thumbnails) would keep public loads cheap.

Design axes in play: `privacy-public-view` · `storage-local-db` (one SQLite db per SFI) ·
`view-collaborative` · `settings-per-sfi`. Posting is editor-gated; reading is fully public;
poll voting sits in between — any real (non-anonymous) Seamside user may vote, member or not,
keyed by `user_id`, while anonymous web viewers see results read-only.
