# Next steps

The frame is intentionally lean — two SyncTables (`members`, `library_assets`), a per-placement JSON prefs file, and a single-page UI. Some natural extensions:

1. **Reservations / waitlist** — let members reserve an item that's currently checked out and notify the next person when it's checked back in.
2. **Checkout history** — a third SyncTable that logs each checkout/checkin event so the community can see who has used an item over time and spot popular items.
3. **Search & filter** — add a search input and toggle chips to filter by status (available / checked out / overdue / issue) and by item type.
4. **Photo per item** — store a small image per asset (data URL or a separate blob) so members can recognize tools and gear at a glance.
5. **Email-on-overdue** — wire up an `email`-style capability so the frame can nudge borrowers when items pass their due date.
6. **Per-item borrow override** — let owners set a different max borrow duration for a specific item (e.g. consumables get shorter loans), independent of the placement default.
7. **Bulk import** — accept a CSV drop to seed the catalog quickly when first standing up the library.
8. **QR-code labels** — generate a printable label per item that, when scanned, deep-links into the frame with that asset selected for fast checkout.
