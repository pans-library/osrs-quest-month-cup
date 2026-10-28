# Live Dink test

A one-off check that a real Dink post travels RuneLite → Cloudflare → the cup and scores, before Quest Month starts. Delete this file once the test is done.

Dink posts sent before `CUP_START` are stored but never shown, so the test needs a temporary start date in the past.

## 1. Prepare

- [ ] A tester who still has an unfinished quest they can complete today. Any quest works; it doesn't need to be in the cup.
- [ ] The tester has Dink installed, with the cup's webhook link as a line under **Primary Webhook URLs** and **Enable Quests** turned on.
- [ ] Back up the database: stop the app, then `docker cp <container>:/data/cup.sqlite ./cup-before-test.sqlite`.

## 2. Redeploy with a past start date

- [ ] Set `CUP_START` to yesterday, e.g. `CUP_START: "2026-10-27T00:00:00Z"`, and redeploy.
- [ ] Add the tester's RSN to the roster if it isn't there.

## 3. Run the test

- [ ] The tester completes the quest in game.
- [ ] Organiser tools → **Quests seen, not in the cup** lists the quest, with the tester as one completion. If the RSN shows under **Unknown players** instead, the roster spelling differs from what Dink sends; note the exact form.
- [ ] Click **Add to cup** on that quest. The tester appears as 1st with **no** "manual" badge, and the points match the scoring scheme.
- [ ] The app's logs show `quest: <RSN> completed <quest>`.

## 4. Clean up and redeploy for Quest Month

- [ ] Remove the test quest from the cup.
- [ ] Set `CUP_START` back to `2026-11-01T00:00:00Z` and redeploy. The test completion is now before the start, so it can't count, and it won't block anyone's real finish of a cup quest.
- [ ] Check the board shows no test data, and that the organiser tools show nothing under **Quests seen, not in the cup**.
- [ ] Close this PR without merging, or delete this file in it and merge.
