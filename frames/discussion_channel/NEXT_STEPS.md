# Discussion Channel — Next Steps

A few directions this frame could grow in:

- **@mentions** — autocomplete from known space members in the composer, highlight matched names in rendered messages, and emit a notification toast when the local user is mentioned.
- **Reply threads** — let a message be a reply to another; render replies indented under the parent and collapse long threads.
- **Inline editing** — allow the author to edit their own message within a short window (e.g. 5 minutes); show an "edited" tag and broadcast a `dc_edit` push.
- **Custom reaction set** — let the channel owner pick which Phosphor icons appear in the picker (per-`sfi_id` allow-list) so each channel has its own reaction vocabulary.
- **Day separators & new-message marker** — group messages by date and draw a thin line where the user last left off, even when scrolled back through history.
- **Slash commands** — `/me`, `/shrug`, `/clear` (owner only), and a pluggable command registry for fun extras like `/roll 2d6`.
- **Search & jump** — a small search box that filters visible messages and scrolls to matches; useful when the channel grows beyond a couple hundred entries.
