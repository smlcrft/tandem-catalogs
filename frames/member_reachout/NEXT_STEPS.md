# Next steps

Member Reachout is intentionally lean: it reads the **shared `members` SyncTable** (bind it
to the same table the Member Manager frame uses) and keeps a local JSON log of every send.
Sending itself happens OS-side via `mailto:` (everyone bcc'd) and per-person `sms:` links.

Ideas to grow it:

1. **Message templates** — let editors save reusable drafts (welcome note, weekly update) in
   the per-sfi settings JSON, and start a new message from one.
2. **Scheduling / reminders** — record a "send again on" date per entry and surface a gentle
   nudge in the header when one is due (still hand-confirmed; no background sending).
3. **Read/links tracking** — append a short tracking token to a link in the body so the log
   can show rough engagement, if the org opts in.
4. **Attachments / RSVP** — for richer updates, link out to a community_home page or a
   help_desk form instead of cramming everything into the message body.
5. **Per-role default channel** — remember whether a given role is usually emailed or texted
   and pre-select the matching send button.
6. **Audience presets** — named groups that span roles (e.g. "Leadership" = Admin + Owner)
   saved in settings, so common sends are one tap.
7. **Export the log** — a download of the sent history (CSV/JSON) for record-keeping, since
   the log is device-local and not synced.
8. **Smarter text run** — remember the last position in a long texting run across reloads via
   `frame.localStorageSetItem`, so an interrupted send can resume where it left off.

Note on logging behaviour: a texting run is only recorded if at least one person was actually
tapped, mirroring how an email send is logged once the `mailto:` is opened. "Everyone" sends
are deliberately never exposed in the public view (they may include private-role recipients).
