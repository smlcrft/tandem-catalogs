# Next steps

The frame is intentionally lean — a SyncTable for the roster, a JSON file for per-placement preferences, and an inline editor. Ideas to extend it:

1. **Search & filter** — add a search input that filters by name/email and a per-role chip filter; pure client-side over the loaded `rows`.
2. **Sort options** — toggle between sort-by-name, sort-by-role, and sort-by-date-added; persist the choice in the prefs JSON.
3. **Avatars / initials** — derive a colored initials chip from the name + a hashed `--os-c{n}` channel for visual distinction.
4. **Email validation & dedupe** — reject obviously malformed emails on the backend and warn (or merge) when adding a member whose email already exists.
5. **CSV import / export** — let owners drop a CSV to bulk-add members and export the current roster for backups.
6. **Activity log** — declare a second SyncTable (`members_activity`) that records role changes / additions / removals so peers can see history.
7. **Per-role permissions** — extend prefs with a `roles_can_edit: string[]` so the owner can grant edit rights to specific roles instead of just owner-only / everyone.
8. **Onboarding date vs added date** — add an explicit `joined_at` column so owners can backdate members whose real join date predates entry into the system.
