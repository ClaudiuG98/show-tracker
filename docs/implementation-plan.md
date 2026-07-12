# IMDb Shows Tracker — Approved Implementation Plan

This document records the approved implementation baseline supplied on 2026-07-11. The detailed requirements in `tracker-plan-prompt.txt` remain normative where this summary is silent.

## Product and repository baseline

Build a local-first Manifest V3 extension for Chrome and Edge using WXT, React, and TypeScript. The full-tab dashboard provides Watch List, Upcoming, Library, show details, import, settings, backup/restore, and attribution. IMDb receives isolated header/title controls. There are no accounts, backend, telemetry, social/community features, movie tracking, or notifications.

The inspected fixtures are the 184-row IMDb CSV, a TV Time ZIP containing 213 shows and 8,368 episodes, and two Watch List screenshots under `initial-data/`. TV Time supplies TVDB identifiers and watched history but no episode release dates. Its 1,953 specials are excluded from primary backlog calculations, and a special is classified conservatively when either season or episode flags it.

## Architecture and data

- WXT MV3 entrypoints: event-driven service worker, React dashboard, and isolated IMDb content script using Shadow DOM.
- `chrome.storage.local`: versioned tracked shows, mappings, watched progress, user state, settings, bounded 500-action history, import decisions, and synchronization markers.
- IndexedDB/Dexie: replaceable TVMaze show/episode metadata, API cache, and staged imports.
- Provider abstraction with TVMaze as the first adapter. Exact IMDb and TVDB lookup precede controlled title matching; ambiguous/conflicting matches are never accepted silently.
- Pure domain functions calculate availability, Watch List, Upcoming, completion, state transitions, and episode ordering.
- Exact airstamps are compared as instants. Date-only releases use a configurable 09:00 local default in the current IANA timezone. Missing dates remain unknown.

## Import and progress rules

Validate and preview files before committing. CSV parsing tolerates BOMs, quoted/reordered columns, aliases, and optional values; only series/miniseries are imported. ZIP processing rejects traversal and enforces 25 MB compressed, 100 MB expanded, 10,000-entry, and 20 MB-per-entry limits. Movie and HTML entries are ignored.

IMDb defines collection membership/addition dates. TV Time provides watched progress and stopped→paused state. TV Time-only shows are reported and excluded by default. Reimports merge without deleting progress. Provider metadata decides whether unwatched episodes are actually available. Exact TVDB episode ID is preferred when exposed, followed by show/season/episode and manual review.

The onboarding/report workflow distinguishes exact matches, IMDb-only, TV Time-only, conflicts, ambiguity, unmatched records, mapped/unmapped episodes, ignored specials, and setup-required shows. Active/uncertain IMDb-only shows default to progress unknown and require progress setup. Finished-show assumptions only mark episodes available before the import instant.

## User experience

Watch List shows the earliest available unwatched regular episode for each eligible show and the additional aired backlog count. Shows are ordered by their newest currently-unwatched release, descending. Marking watched is local and immediately advances/removes the card; undo restores the prior snapshot. Paused and not-started shows are suppressed.

Upcoming shows the nearest future regular episode per show in chronological order. Show detail supports individual watched/unwatched operations and season/caught-up operations restricted to available episodes. Library supports search and progress filters. The visual system uses dark IMDb-compatible surfaces, restrained `#f5c518` accents, semantic controls, visible focus, reduced motion, responsive layouts, and an explicit unofficial-extension notice.

## Synchronization, security, and release

Run a daily alarm plus an opportunistic six-hour dashboard refresh. Query TVMaze changed-show timestamps using day/week/month/all windows, intersect tracked IDs, and fetch only changed metadata. Handle 404 without retry, and 429/network/5xx with bounded retry, jitter/backoff, concurrency four, and approximately two starts per second. Recompute releases at startup, dashboard open, synchronization, timezone/settings changes, and the nearest stored release alarm.

Permissions are limited to `storage`, `alarms`, IMDb, and the TVMaze API/image hosts actually used. All executable code is packaged; messages and imports are schema-validated; provider text is rendered safely; page scripts never receive storage; backups are identified as sensitive. Display TVMaze attribution/links and CC BY-SA notice wherever its data appears.

## Delivery milestones and acceptance

1. Scaffold/build and fixture tests.
2. Domain models, selectors, persistence, migrations, recovery, and history.
3. TVMaze provider, caching, update synchronization, and resilience.
4. IMDb and TV Time import, reconciliation, report, onboarding, and atomic commit.
5. Watch List, Upcoming, Library, show details, scheduling, and state actions.
6. IMDb injection, backup/restore, accessibility, security, Chrome/Edge packaging, and Web Store readiness.

Acceptance requires successful TypeScript checking, importer/domain/provider unit and integration tests, Chromium E2E coverage for dashboard/import/IMDb injection/progress/backup flows, production Chrome and Edge builds, minimum permissions, no bundled private fixtures, and preserved progress across cache resets and migrations.
