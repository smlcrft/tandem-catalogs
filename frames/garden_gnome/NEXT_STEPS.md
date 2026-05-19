# Garden Gnome — Next Steps

A few directions this frame could grow in:

- **Care suggestions** — translate the indicator scores into a one-line action ("water tomatoes today", "shade peppers, heat wave incoming") and surface the highest-priority suggestion at the top of the card list.
- **Per-plant overrides** — let the gardener nudge a plant's ideal water/temp/UV bands when their cultivar runs hot or cold compared to the species default; persist alongside the chosen plant key.
- **Sun-hours-per-spot** — add an optional "mostly shaded" toggle per plant so a strawberry patch under a tree gets its UV signal halved before scoring.
- **Notifications** — if a plant flips to a -2 or +2 score and stays there past one refresh, push a `bus_frame_to_ui` toast so the user sees it without opening the frame.
- **History sparkline** — keep the last 24 hours of indicator scores (in-memory or a small JSON ring) and render a tiny sparkline above each spectrum to show the trend, not just the snapshot.
- **Custom plants** — let users add a free-text plant with its own ideal bands so things outside the bundled catalog (rhubarb, lavender, etc.) still get indicators.
- **Daily journal hook** — log each settings save and indicator snapshot to a per-day JSON entry the gardener can scroll back through, useful when troubleshooting why a crop struggled.
