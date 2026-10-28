# Changelog

Container images are published to `ghcr.io/pans-library/osrs-quest-month-cup`. Each release is tagged `X.Y.Z`, `X.Y` and `X`; `latest` follows `main`.

## 1.0.0

First release, ready for Quest Month (November 2026).

### Scoreboard
- Standings ranked by points, with podium counts and ties broken by more 1st places, then 2nd, and so on.
- A card per quest showing finish order, times and points, coloured like the in-game quest list, and linked to the OSRS Wiki.
- Light and dark themes, phone-friendly layout, trophy favicon.

### Finishes from Dink
- Quest completions arrive from the Dink RuneLite plugin through a secret webhook path, as JSON or with a screenshot.
- Only completions after `CUP_START` count. Seasonal worlds are ignored, and a repeated post for the same finish is skipped.
- Completions are kept even for players or quests not yet in the cup, so adding them later picks up earlier finishes.

### Organiser tools
- Unlocked with `ADMIN_TOKEN`: add or remove players and quests, edit release dates and wiki links, and log a finish by hand.
- A ready-to-paste message for friends, and the Dink webhook link to send privately.
- Lists of quests and RSNs that have reported in but aren't in the cup yet.
- Quests preloaded from `seed/quests.json`, or your own file via `SEED_FILE`.

### Scoring
- Linear (default), Standard, Dynamic and Custom schemes, fixed with `SCORING` or chosen in the scoring lab.
- A public scoring lab at `/scoring` that compares schemes, runs rule checks and plays out matchups that expose degenerate strategies.

### Running it
- One Docker image, Node 26 LTS with no dependencies, storing everything in SQLite.
- Setup guides for Docker Compose, TrueNAS SCALE and Cloudflare Tunnel, with CPU, memory and process limits.

### Security
- Tokens are compared in constant time, and the webhook path is never logged.
- Webhook input is size- and type-checked, buffered uploads and stored events are capped, and requests time out.
- Strict security headers, including a Content-Security-Policy with hashed inline scripts and no framing.
- The container runs as a non-root user on a read-only filesystem.
- Images are built only from `main` and release tags, with provenance and an SBOM.
