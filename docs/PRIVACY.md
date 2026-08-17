# Privacy Policy — TV Show Tracker for IMDb

**Last updated:** 16 August 2026

## The short version

This extension does not collect, transmit, sell, or share any personal data. There is no
account, no backend server, and no analytics or telemetry of any kind. Everything you track
stays in your own browser.

## What the extension stores, and where

All of it is stored locally on your computer, by the browser, and none of it is sent anywhere.

| Data | Where it is stored | Why |
|---|---|---|
| Your tracked shows, watch progress, watch history and settings | `chrome.storage.local` | This is the tracker itself |
| Show and episode metadata from TVMaze (titles, air dates, artwork URLs) | IndexedDB | Cached so the extension works without re-downloading constantly |
| Files you import (IMDb CSV, TV Time or Refract ZIP) | Read in memory only | Parsed in the page and never uploaded |

Uninstalling the extension removes all of it. You can also erase everything at any time from
**Settings → Start over → Remove all data**.

## Network requests

The extension contacts exactly one third-party service:

- **TVMaze (`https://api.tvmaze.com`)** — to look up show and episode information. These requests
  contain only the show identifier or search text being looked up. They do not contain your
  identity, your watch history, or anything else about you. TVMaze's own privacy practices are
  described at <https://www.tvmaze.com/privacy>.

No requests are made to any server operated by the developer, because there isn't one.

## Files you import

Import files are read in your browser and parsed locally. They are never uploaded. The extension
keeps only what it needs — which shows you watch and how far through them you are — and discards
the rest when the import finishes.

## Backups

**Settings → Export JSON backup** writes a file to your computer containing your library,
progress, history and settings. That file is yours: the extension does not send it anywhere and
has no access to it once saved. Treat it as you would any personal file.

## Pages the extension runs on

A small script runs on `https://www.imdb.com/*` to add a "Tracker" button next to IMDb's own
controls. It reads only the page address and the page's public title information in order to know
which show you are looking at. It does not read your IMDb account, your cookies, or anything you
type, and it sends nothing to IMDb or to anyone else.

## Notifications

The extension does not use desktop or system notifications. When a new episode becomes available
it marks its own toolbar icon, which requires no notification permission and sends nothing outside
the browser.

## Children

The extension is not directed at children and collects no data from anyone.

## Changes

Any change to this policy will be published in this file alongside the extension's source code,
with the date above updated.

## Contact

Questions or concerns can be raised as an issue on the project's repository.
