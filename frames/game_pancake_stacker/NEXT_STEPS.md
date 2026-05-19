# Pancake Stacker — Next Steps

Directions this frame could grow in:

- **Perfect-drop bonus** — if the overlap is within a few pixels of the previous pancake's full width, don't trim and award a small width bonus. Standard stacker-game flourish that rewards precision.
- **Combo streaks** — track consecutive perfect drops and surface a streak counter; reset on any trim. Could unlock toppings (a pat of butter, a strawberry) drawn on the top pancake as a visual reward.
- **Difficulty curve** — currently speed scales with `score * 0.18`. Add a second axis (start-side randomization, mid-track pauses, brief wind drifts) so late-game challenge isn't just "faster."
- **Multiplayer race** — switch the axis combo to `storage-shared-table` + `view-collaborative` and let multiple viewers stack against each other on adjacent griddles in real time. Top of leaderboard wins the round.
- **Skins** — let the placement owner pick a theme via `settings-per-sfi` (pancakes / waffles / dosas / blini), persisted in the same JSON file as the high score.
- **Replay ghost** — record the (x, w) sequence of the current high-score run and overlay a ghost pancake at the moving pancake's position so the player can see whether they're tracking the record.
- **Sound** — small "plap" on land, a short cheer on new best. Bundle the WAVs under `public/` and play via `<audio>` elements.
