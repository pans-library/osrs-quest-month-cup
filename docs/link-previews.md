# Link previews (planned)

Placeholder for adding Open Graph and Twitter card tags, so a link to the scoreboard pasted into Discord or another chat shows a card instead of a bare URL.

## Plan
- Add `og:title`, `og:description`, `og:type`, `og:url`, `og:image` and `twitter:card` tags to `public/index.html` and `public/scoring.html`.
- Add a 1200 × 630 PNG preview image (trophy and "Quest Month Cup" on the page background) and serve it from the static allowlist.
- `og:url` and `og:image` must be absolute URLs, but the server doesn't know its public hostname. Either add a `PUBLIC_URL` setting and insert it at start-up (this also changes the CSP hash, so compute the hash after inserting), or build it from the request's `Host` header, which Cloudflare sets.
- Optionally a live description, e.g. "Leader: Fally Fae, 24 points · 3 quests", built from the current standings when the page is served.

## Check before merging
- Discord's embed debugger, or a test post in a private channel, shows the card.
- No secrets or organiser-only data in any tag.
