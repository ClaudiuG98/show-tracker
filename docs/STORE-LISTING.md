# Chrome Web Store submission notes

Reference copy for the fields the review form asks for. Keep it in step with `wxt.config.ts`.

## Single purpose

Track which episodes of your TV shows you have watched, using lists you already keep on IMDb and
your viewing history exported from TV Time or Refract.

## Permission justifications

Paste these into the corresponding fields in the developer dashboard.

### `storage`
Stores the user's own tracker data — their shows, watch progress, history and settings — in local
browser storage. This is the extension's core function. Nothing is transmitted.

### `alarms`
Schedules two background jobs: a once-daily check for updated show metadata from TVMaze, and a
one-shot timer for when the next episode of a tracked show is due, which is what triggers the new
episode notification. Without alarms the extension could only refresh while its dashboard was
open.

### `notifications`
Shows a browser notification when a new episode of a show the user is currently watching becomes
available. Notifications are limited to shows already in the user's library, and can be switched
off in the extension's settings.

### Host permission — `https://api.tvmaze.com/*`
TVMaze is the sole source of show and episode information: titles, season and episode numbering,
air dates and artwork. The extension has no backend of its own, so every piece of show metadata
comes from this API. Requests contain only the identifier or search text being looked up.

### Host permission — `https://www.imdb.com/*`
A content script adds a "Tracker" button to IMDb pages so the user can open the tracker, and on a
TV series page see at a glance whether that show is already tracked and add it if not. The script
reads the page address and the page's public structured title data to identify the show. It does
not read the user's IMDb account or cookies and sends nothing to IMDb.

### Remote code
None. All scripts are bundled in the package; the content security policy is `script-src 'self'`.

## Data disclosures

Answer **No** to every collection category. The extension collects no data. Then tick:

- "I do not sell or transfer user data to third parties, outside of the approved use cases"
- "I do not use or transfer user data for purposes that are unrelated to my item's single purpose"
- "I do not use or transfer user data to determine creditworthiness or for lending purposes"

Privacy policy URL: link to `docs/PRIVACY.md` in the public repository.

## Listing copy

**Short description (132 characters max):**

> A private, local TV episode tracker. Import your IMDb lists and TV Time history, and never lose
> track of where you left off.

**Detailed description:**

> TV Show Tracker keeps track of which episodes you have watched, entirely on your own computer.
>
> • Import your IMDb watchlists and custom lists, plus your full viewing history from TV Time or
>   Refract. Watch progress, ratings and the dates you added shows all come across.
> • A Watch List that shows only what you can actually watch next — the earliest unwatched episode
>   of each show, with anything unreleased kept out of the way.
> • Optional notifications when a new episode of a show you are watching becomes available.
> • Back up and restore everything as a single JSON file.
>
> There is no account and no server. Your library, your progress and your history are stored in
> your browser and are never sent anywhere. The only network requests go to TVMaze, to look up
> show and episode information.
>
> Show data is provided by TVMaze under CC BY-SA. This is an unofficial extension and is not
> affiliated with, endorsed by, or sponsored by IMDb, TV Time, Refract or TVMaze.

## Pre-submission checklist

- [ ] Bump `version` in `wxt.config.ts` from `0.1.0` to `1.0.0`
- [ ] Publish `docs/PRIVACY.md` at a public URL and paste that URL into the listing
- [ ] Upload screenshots (1280×800 or 640×400)
- [ ] Verify the "Tracker" button appears on a real IMDb series page in a normal browsing session
      — automated browsers are served IMDb's human-verification wall, so this cannot be checked
      in CI
- [ ] Confirm a test notification arrives via Settings → Send a test notification
- [ ] `npm run build` and upload `.output/chrome-mv3` zipped
