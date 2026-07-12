# IMDb Shows Tracker — Ultra Review

Review date: 2026-07-11

## Review scope and evidence

This was a review-only pass. No production code or tests were changed. The only repository change made by this review is this document. A current Git diff could not be inspected because the workspace is not a Git repository: both `git status` and `git diff` returned `fatal: not a git repository`.

The requested root-level `tracker-plan-prompt.txt` was not present; the equivalent file at `docs/tracker-plan-prompt.txt` was read in full. `docs/implementation-plan.md` was also read in full. No `AGENTS.md` files exist. The IMDb CSV, TV Time ZIP, and both reference screenshots under `initial-data/` were inspected. The screenshots confirm the intended single-card advancement workflow, additional-backlog count, watched history, and separation of Watch List and Upcoming.

Finding classifications used below:

- **Confirmed defect**: demonstrated by code, a targeted probe, a build/runtime check, or an existing test.
- **Likely risk**: the implementation is vulnerable by construction, but the complete failure was not exercised end-to-end.
- **Plan deviation**: approved behavior is absent or materially different.
- **Optional improvement**: useful but not required for correctness or MVP acceptance.

## Critical

### C1. Restore can irreversibly replace valid state with malformed data

- **Severity / classification:** Critical — confirmed defect and plan deviation.
- **Location:** `src/backup/backup.ts:7-8` (`backupEnvelope`, `parseBackup`); `src/ui/App.tsx:65` (`restore`); `src/storage/local-state.ts:34-35` (`writeLocalState`).
- **Why it matters:** Backup validation treats every show, progress record, and history record as `unknown`, accepts arbitrary setting strings, casts that shallow envelope to `TrackerBackup`, and immediately replaces the entire current state. There is no merge preview, replace confirmation, current-state safety backup, size limit, or validation of nested identifiers and enums.
- **Reproduction:** A correctly shaped top-level JSON backup with `shows:[null]`, `progress:[{"watched":"yes"}]`, `schemaVersion:999`, and `timezone:"not/a-zone"` passes `parseBackup`; restoring it writes the value permanently and subsequent UI code such as `App.tsx:38` can crash while dereferencing a null show.
- **Recommended correction:** Define strict, versioned schemas for all user-owned records; reject unsupported versions and oversized files; validate before writing; preview merge/replace effects; default to merge by stable/external IDs; require explicit confirmation and generate a safety backup before replacement.
- **Impact:** **Data loss: yes. Incorrect progress: yes. Release failure: yes.**

### C2. Undoing an older visible history item erases newer progress

- **Severity / classification:** Critical — confirmed defect.
- **Location:** `src/ui/App.tsx:29` exposes Undo for every displayed action; `src/ui/useTracker.ts:41-46` (`undo`).
- **Why it matters:** Undo deletes every current progress record for the show and restores the selected action's complete `before.episodes` snapshot, regardless of later actions. Later history remains present even though its state was erased.
- **Reproduction:** Mark E1 watched, mark E2 watched, then click Undo on the older E1 history row. Both E1 and E2 become unwatched because the tracker restores the pre-E1 snapshot.
- **Recommended correction:** Store compact inverse deltas and apply only fields touched by the action with revision/conflict checks, or expose Undo only for the latest applicable action. Record show-state actions as history too and test out-of-order cases.
- **Impact:** **Data loss: yes. Incorrect progress: yes. Release failure: no.**

## High

### H1. The required import review and onboarding state machine is absent

- **Severity / classification:** High — confirmed plan deviation and MVP blocker.
- **Location:** `src/ui/App.tsx:50-59`; `src/imports/commit.ts:11-42`.
- **Why it matters:** The UI moves directly from count-only parsing to “Resolve, reconcile and commit.” There is no pre-commit match report, conflict review, finished-show bulk question, mixture selection, active-show episode review, caught-up/not-started/last-watched/manual-gap actions, or final commit preview. IMDb-only matches are committed as `progress_unknown` and hidden from Watch List.
- **Reproduction:** Select the supplied IMDb CSV and press the sole commit button. Provider matches are permanently written without any of the approved progress decisions.
- **Recommended correction:** Implement the staged import session and approved state machine before permanent writes, including Created-descending mixture review and active/incomplete per-show progress setup.
- **Impact:** **Data loss: no. Incorrect progress: yes. Release failure: yes.**

### H2. Partial provider failures are still committed as a completed import

- **Severity / classification:** High — confirmed defect.
- **Location:** `src/imports/commit.ts:14-19,21-39`; unused staging declarations at `src/storage/database.ts:5,11,19`; marker declaration at `src/storage/local-state.ts:14`.
- **Why it matters:** Lookup and episode errors are accumulated, successful subsets are written, and the import receives `marker:"complete"`. If an episode request fails, no TV Time watched history is mapped, yet the show can still be committed. Raw normalized import data is not staged, so a later metadata refresh cannot recover it. Prepared/local-committed recovery states are never used.
- **Reproduction:** Make one matched show's episode request fail. The report says the import completed with an error, the show exists, and its imported watched history is absent until the user manually reimports.
- **Recommended correction:** Persist normalized sources and decisions in a staging transaction, distinguish unmatched records from required fetch failures, commit only after required analysis is complete, and implement idempotent prepared/local-committed/complete recovery.
- **Impact:** **Data loss: yes, for imported history. Incorrect progress: yes. Release failure: yes.**

### H3. Exact episode IDs, season differences, and unresolved mappings are not handled

- **Severity / classification:** High — confirmed defect and plan deviation.
- **Location:** `src/imports/reconcile.ts:24-31`; `src/providers/tvmaze/provider.ts:31-39`; `src/domain/models.ts:49-59`.
- **Why it matters:** `mapTvTimeProgress` uses only a `season:number` map. It never compares TVDB episode IDs, even though the models contain those fields, and the TVMaze adapter never populates `tvdbEpisodeId`. Season-number differences therefore silently discard watched history, with no title/date fallback or unresolved-episode review.
- **Reproduction:** A TV Time episode and provider episode with the same TVDB episode ID but S2E1 versus S3E1 map to zero progress records.
- **Recommended correction:** Populate compatible external episode IDs where available; match exact TVDB episode ID first, then show/season/episode; preserve title/date candidates for controlled fallback; report every unresolved episode for manual review.
- **Impact:** **Data loss: yes, for imported progress. Incorrect progress: yes. Release failure: yes.**

### H4. Conflict, ambiguity, and TV Time-only decisions do not exist

- **Severity / classification:** High — confirmed plan deviation.
- **Location:** `src/imports/reconcile.ts:5-21`; `src/imports/commit.ts:36-42`; `src/ui/App.tsx:58-59`.
- **Why it matters:** `ShowMatch.kind` declares `conflict`, but no code creates one and `reconcileShows` is unused. Exact lookups are performed independently; differing provider IDs become separate IMDb-only/TV Time-only counts. There is no title/year candidate generation, ambiguity confirmation, or user-selectable TV Time-only inclusion. `commit.ts:37` imports TV Time progress only when an IMDb row resolved to the same TVMaze ID.
- **Reproduction:** Importing the supplied ZIP alone adds zero tracked shows. A same-named IMDb and TV Time record resolving to different provider IDs receives no conflict UI and loses the opportunity to apply history.
- **Recommended correction:** Make matching a read-only analysis phase, explicitly associate source records, stop on differing exact IDs, present candidates and conflicts, and provide default-off per-show/bulk selection for TV Time-only shows.
- **Impact:** **Data loss: yes, for unapplied history. Incorrect progress: yes. Release failure: yes.**

### H5. Explicit TV Time unwatched flags cannot replace older assumptions/history

- **Severity / classification:** High — confirmed defect.
- **Location:** `src/imports/reconcile.ts:24-31`; `src/imports/commit.ts:34`.
- **Why it matters:** Mapping filters to `e.watched` and emits only true records. Commit removes only existing records whose IDs appear in that true-only result. An earlier `assumption` or TV Time watched record survives when a newer export explicitly marks the episode unwatched.
- **Reproduction:** Seed E1 as watched from an IMDb assumption, then import a confidently mapped TV Time E1 with `is_watched:false`; the old watched record remains.
- **Recommended correction:** Normalize both watched and unwatched TV Time states and replace older assumption/TV Time state for confidently mapped episodes. Preserve later explicit local user actions only under a documented conflict policy shown in preview.
- **Impact:** **Data loss: no. Incorrect progress: yes. Release failure: no.**

### H6. Concurrent local-state updates can silently overwrite each other

- **Severity / classification:** High — confirmed reliability/data-integrity risk.
- **Location:** `src/storage/local-state.ts:38-42`; callers in `src/ui/useTracker.ts`, `src/imports/commit.ts`, `src/scheduling/sync.ts`, and `entrypoints/background.ts`.
- **Why it matters:** Each mutation performs independent `get → mutate → set` operations with no single-writer queue, lock, revision, or compare-and-swap. Two fast UI actions, or a UI action concurrent with background work, can read the same snapshot and the last write erases the other.
- **Reproduction:** Trigger two `updateLocalState` calls before either write completes; both mutate the same initial object, and the second `chrome.storage.local.set` wins.
- **Recommended correction:** Centralize persistent mutations in a serialized service-worker command queue or add revisioned compare-and-swap with retry. Test concurrent watched actions, sync, restore, and import.
- **Impact:** **Data loss: yes. Incorrect progress: yes. Release failure: no.**

### H7. History representation can exceed storage quota and bulk actions are non-atomic

- **Severity / classification:** High — confirmed design defect.
- **Location:** `src/domain/models.ts:62-74`; `src/ui/useTracker.ts:21-37,52-54`; `src/storage/local-state.ts:35`.
- **Why it matters:** Every action stores the show's full progress twice. “Mark caught up” performs one storage write, history snapshot, and reload per episode. A 500-entry count cap does not bound bytes; a synthetic 180-episode action was approximately 62.7 KB, putting 500 actions near 30 MB, above normal `storage.local` quota. Failure can occur partway through a bulk operation and is not surfaced.
- **Reproduction:** Catch up a long-running show repeatedly or generate 500 large show snapshots; eventually `chrome.storage.local.set` can reject after some episodes were already written.
- **Recommended correction:** Store compact per-episode deltas, create one atomic bulk action, enforce a byte-aware retention policy, and report write/quota failures.
- **Impact:** **Data loss/partial progress: yes. Incorrect progress: yes. Release failure: yes.**

### H8. TVMaze retry recursion can deadlock under throttling/outage

- **Severity / classification:** High — confirmed defect by control-flow inspection.
- **Location:** `src/providers/tvmaze/client.ts:16-35`.
- **Why it matters:** A request owns a concurrency slot while sleeping and recursively calling `request()`; the outer `finally` cannot release its slot until the recursive call finishes. Four simultaneous first-attempt 429/5xx responses consume all four slots and each recursive call waits forever. Fewer requests can deadlock on deeper retries.
- **Reproduction:** Mock four distinct concurrent requests to return 429 on the first attempt; all recursive attempts wait in `acquire()` while the outer attempts await them.
- **Recommended correction:** Implement retries as an iterative loop that releases each slot before backoff/requeue, honor numeric and HTTP-date `Retry-After`, and add four-way 429/5xx/network tests with a hard completion timeout.
- **Impact:** **Data loss: no. Incorrect progress: no. Release failure: yes.**

### H9. Changed-show intersection is backwards and polls unchanged/ended shows

- **Severity / classification:** High — confirmed defect and plan deviation.
- **Location:** `src/scheduling/sync.ts:17-33`, especially line 22.
- **Why it matters:** For an unchanged tracked ID omitted from `/updates/shows?since=...`, `changed.get(id)` is `undefined`; it is not equal to a numeric `providerUpdatedAt`, so the code fetches the show and episodes anyway. Routine sync therefore refetches almost every mapped show, including ended shows.
- **Reproduction:** Return an empty changed-show map with a previous successful sync and one tracked provider ID. The loop still calls both show endpoints.
- **Recommended correction:** With prior sync state, skip IDs absent from the changed map; fetch only present IDs whose timestamp differs. Add an explicit, separate force-hydration/integrity path.
- **Impact:** **Data loss: no. Incorrect progress: possible under throttling. Release failure/API reliability: yes.**

### H10. Cache reset and clean restore can leave metadata missing indefinitely

- **Severity / classification:** High — confirmed defect.
- **Location:** `src/storage/database.ts:25-28`; `src/scheduling/sync.ts:18-28`; `src/ui/App.tsx:65-66`.
- **Why it matters:** Metadata reset clears IndexedDB but retains `lastSyncAt` and provider timestamps. Once H9 is fixed naively—or whenever a changed timestamp equals the stored value—sync has no cache-presence check and can skip hydration. A backup restored into a clean profile has the same problem because backups intentionally omit replaceable metadata but retain sync markers.
- **Reproduction:** Sync a show, clear metadata, and refresh while its TVMaze timestamp is unchanged; Watch List and Upcoming remain empty. Restore a backup into an empty profile for the same result.
- **Recommended correction:** Make synchronization cache-aware. Reset/restore must invalidate hydration markers or explicitly force-fetch every tracked mapped show whose metadata/episodes are absent, then recompute alarms and selectors.
- **Impact:** **Data loss: no, progress remains. Incorrect display/progress decisions: yes. Release failure: yes.**

### H11. ZIP protections are applied after decompression and can be bypassed

- **Severity / classification:** High — confirmed security/reliability defect.
- **Location:** `src/imports/tvtime.ts:23-32`.
- **Why it matters:** `unzipSync` materializes all selected JSON before the cumulative 100 MB check. The 10,000-entry check counts only entries surviving the JSON filter, not the archive central directory. A targeted 10,002-entry archive with 10,001 ignored text entries was accepted. High-compression JSON can allocate substantial memory before rejection.
- **Reproduction:** Supply the described many-entry archive or a 25 MB compressed archive containing many individually sub-20 MB high-ratio JSON entries. The dashboard performs synchronous decompression before enforcing the total.
- **Recommended correction:** Inspect and count the central directory before decompression, sum declared sizes, reject encryption and excessive ratios, stream/decompress under a hard cumulative cap in a worker, and test bombs/malformed archives.
- **Impact:** **Data loss: no. Incorrect progress: no. Release failure/security DoS: yes.**

### H12. IMDb's asynchronous injection race creates duplicate controls

- **Severity / classification:** High — confirmed runtime defect.
- **Location:** `entrypoints/imdb.content/index.ts:9-24` (`inject`); lines 27-29 (`MutationObserver`).
- **Why it matters:** `inject()` awaits status before appending/reserving its host. During the await, IMDb mutations invoke more `inject()` calls, all of which see no existing root and later append duplicates with the same ID and event handlers.
- **Reproduction:** The unpacked build produced **six** `#imdb-shows-tracker-root` elements on the live IMDb Game of Thrones page during this review. A deterministic mutation-heavy IMDb fixture produced **82 roots** in 1.5 seconds.
- **Recommended correction:** Reserve/append the host synchronously before awaiting, guard with one in-flight route token, cancel stale URL work, and debounce only relevant DOM mutations.
- **Impact:** **Data loss: no. Incorrect/duplicate actions: possible. Release failure: yes.**

### H13. IMDb controls are not the approved header/title integration

- **Severity / classification:** High — confirmed plan deviation.
- **Location:** `entrypoints/imdb.content/index.ts:13-24`.
- **Why it matters:** Both controls are placed in one fixed bottom-right overlay. There are no ranked header/Watchlist selectors, title-action placement, computed host styles, or robust layout fallback. The global control has no waiting-show badge; the tracked show has no progress menu.
- **Reproduction:** Inspect any IMDb page with the extension: the host is `position:fixed; right:20px; bottom:20px` rather than integrated into the header/title action regions.
- **Recommended correction:** Implement separate idempotent header and title placement adapters with ranked semantic selectors, a safe fallback, an accessible waiting badge, and a keyboard-operable tracked menu.
- **Impact:** **Data loss: no. Incorrect progress: no. Release failure: yes.**

### H14. Title controls appear on movies and the “Tracked” button remains broken

- **Severity / classification:** High — confirmed runtime defect and plan deviation.
- **Location:** `entrypoints/imdb.content/index.ts:3,16-23`.
- **Why it matters:** Eligibility is only a `/title/tt...` URL regex, so movies, episode pages, and unsupported title types get “Track show.” After a successful add, only the text changes; immutable `status.tracked` in the closure remains false, so the next click calls add again instead of opening the tracker. The required tracked progress menu is absent.
- **Reproduction:** A movie fixture at `/title/tt1234567/` exposed accessible `Tracker` and `Track show` buttons. A live TVMaze-backed series button changed to “Tracked,” but clicking it again opened no dashboard tab.
- **Recommended correction:** Have the service worker return explicit supported-series/miniseries classification before rendering, maintain current tracked state/show ID, open the show route after add, and implement the approved menu/actions.
- **Impact:** **Data loss: no. Incorrect tracking attempts: yes. Release failure: yes.**

### H15. Completed shows never revive and core state transitions are not derived

- **Severity / classification:** High — confirmed defect.
- **Location:** `src/domain/selectors.ts:34-41`; `src/scheduling/sync.ts:17-34`; `src/ui/useTracker.ts:19-50`; `src/ui/App.tsx:46-48`.
- **Why it matters:** `completed` is always filtered from Watch List, but metadata sync never changes user state when a revival/new regular episode appears. Marking the final backlog episode does not derive caught-up/completed. Conversely, “Mark caught up” marks every ended show completed without checking known future episodes or metadata completeness.
- **Reproduction:** Mark an ended show completed, then add/sync a new aired regular episode; it remains excluded. Mark a currently ended show with a future announced episode caught up; UI sets completed anyway.
- **Recommended correction:** Centralize pure state derivation and run it after progress actions, import, restore, metadata synchronization, startup, and release transitions. Preserve paused/not-started overrides.
- **Impact:** **Data loss: no. Incorrect progress/missed releases: yes. Release failure: yes.**

## Medium

### M1. TVMaze responses have no persistent application cache

- **Severity / classification:** Medium — confirmed plan deviation.
- **Location:** `src/storage/database.ts:4,10,18`; `src/providers/tvmaze/client.ts:1-44`.
- **Why it matters:** The IndexedDB cache table is unused except reset; the client only deduplicates currently in-flight requests. Reimports repeat every exact lookup and episode fetch, and negative lookups have no TTL.
- **Reproduction:** Reimport the same files; the same lookup endpoints are requested again.
- **Recommended correction:** Add validated positive/negative endpoint caching with the approved TTLs and stale/error behavior; retain provider metadata until changed timestamps require replacement.
- **Impact:** **Data loss: no. Incorrect progress under outages: possible. Release failure/API risk: yes.**

### M2. One bad show aborts synchronization; episode 404 can erase valid cache

- **Severity / classification:** Medium — confirmed defect.
- **Location:** `src/scheduling/sync.ts:20-29`; `src/providers/tvmaze/provider.ts:30-34`.
- **Why it matters:** There is no per-show error isolation. A failure aborts remaining shows and prevents sync status/alarm recomputation. Separately, an episode-list 404 becomes `[]`; when show metadata succeeds, sync deletes the old episode list and replaces it with empty data.
- **Reproduction:** Throw for one early tracked show or return 404 for `/shows/:id/episodes`; later shows are skipped or cached episodes disappear.
- **Recommended correction:** Use typed success/not-found/error results, retain stale cache on failure, continue per show, mark mappings stale, and update timestamps only for successfully refreshed records.
- **Impact:** **Data loss: replaceable metadata only. Incorrect progress/display: yes. Release failure: yes.**

### M3. The daily alarm is reset on every service-worker start

- **Severity / classification:** Medium — confirmed defect.
- **Location:** `entrypoints/background.ts:9-11`; `src/scheduling/sync.ts:37-39`.
- **Why it matters:** Every worker start calls `chrome.alarms.create` with a one-minute delay on the same named alarm, replacing its schedule. Frequent starts can cause excess near-immediate syncs or indefinitely move the baseline.
- **Reproduction:** Repeatedly wake/restart the worker and inspect the alarm's scheduled time.
- **Recommended correction:** Read the existing alarm and create/repair it only when absent or invalid. Recompute the release alarm separately.
- **Impact:** **Data loss: no. Incorrect progress: no. Release/API reliability: yes.**

### M4. An open dashboard does not update when a release alarm fires

- **Severity / classification:** Medium — confirmed defect.
- **Location:** `src/scheduling/sync.ts:42-54`; `src/ui/useTracker.ts:11-17`.
- **Why it matters:** The release alarm updates only toolbar badge/alarm. Dashboard state loads once and has no timer, runtime listener, or storage listener. Upcoming remains stale until navigation/reload/action.
- **Reproduction:** Leave Upcoming open across a release instant; the card does not move to Watch List automatically.
- **Recommended correction:** Broadcast an availability-invalidated event and reload open views; also schedule a local nearest-release timer in dashboard contexts.
- **Impact:** **Data loss: no. Incorrect progress display: temporarily yes. Release failure: yes.**

### M5. Release-hour/timezone changes do not reschedule alarms; DST-gap policy is wrong

- **Severity / classification:** Medium — confirmed defect.
- **Location:** `src/ui/App.tsx:62-66`; `src/domain/models.ts:82-85`; `src/domain/availability.ts:15-18`.
- **Why it matters:** Settings write only reloads the page, not the background alarm. The timezone is detected once and never updated after travel/system changes. `fromZonedTime` is used without a round-trip validity policy; nonexistent configured wall times during DST gaps map to an earlier local time.
- **Reproduction:** `2025-03-30 03:30 Europe/Bucharest` converts to an instant that round-trips as 02:30, one hour before the requested nonexistent time. Change the release hour and inspect the existing alarm: it remains unchanged.
- **Recommended correction:** Validate settings, detect IANA-zone changes on startup/open, round-trip wall times with explicit gap/overlap policy, and send a background recompute command after changes.
- **Impact:** **Data loss: no. Incorrect release timing: yes. Release failure: no.**

### M6. Required six-hour/on-open and integrity synchronization are absent

- **Severity / classification:** Medium — confirmed plan deviation.
- **Location:** `src/ui/useTracker.ts:11-17`; `src/scheduling/sync.ts:11-15,37-39`.
- **Why it matters:** Dashboard open only reads storage. There is no six-hour stale check and no independent 90-day integrity timestamp/reconciliation.
- **Reproduction:** Open the dashboard more than six hours after the last successful sync; no sync message is sent.
- **Recommended correction:** Add stale-on-open synchronization and a separate infrequent integrity marker that does not individually poll unchanged ended shows.
- **Impact:** **Data loss: no. Stale schedules/progress display: yes. Release failure: possible.**

### M7. Import selection can reuse a stale prior file, trusts extensions, and blocks the UI

- **Severity / classification:** Medium — confirmed defects/plan deviation.
- **Location:** `src/ui/App.tsx:51-54`; `src/imports/tvtime.ts:23-46`; `src/imports/imdb.ts:33-54`.
- **Why it matters:** Selecting new files does not clear old IMDb/TV Time state; selecting a replacement CSV after CSV+ZIP silently retains the old ZIP. File type is chosen solely by extension. CSV has no size/row cap, and CSV/ZIP parsing plus `unzipSync` runs synchronously on the dashboard thread.
- **Reproduction:** Select CSV A+ZIP A, then select only CSV B; commit still includes ZIP A. Rename content to the wrong allowed extension or parse a large file to freeze the page.
- **Recommended correction:** Start a fresh explicit import session on selection, display filenames/hashes, sniff signatures/structure, cap CSV bytes/records, and parse/decompress in a worker.
- **Impact:** **Data loss: no. Incorrect progress: yes. Release failure/DoS: possible.**

### M8. TV Time parsing is brittle and all-or-nothing

- **Severity / classification:** Medium — likely compatibility risk.
- **Location:** `src/imports/tvtime.ts:5-11,35-36`.
- **Why it matters:** Every field/status/timestamp must exactly match the supplied fixture. A new status, missing optional boolean/count, nullable episode name, or one malformed record rejects the whole archive rather than reporting a variation.
- **Reproduction:** Remove `is_favorite` or introduce an unknown status in one show; Zod rejects the entire array.
- **Recommended correction:** Version and normalize reasonable schema variants, distinguish required identifiers from optional fields, and produce per-record validation reports where safe.
- **Impact:** **Data loss: no. Incorrect progress: no. Release failure for future exports: yes.**

### M9. Reimport analysis is unused and manual state can be overwritten

- **Severity / classification:** Medium — confirmed plan deviation/defect.
- **Location:** unused `diffImdbImports` at `src/imports/imdb.ts:57-64`; `src/imports/commit.ts:27,30-31`; `src/ui/App.tsx:50-59`.
- **Why it matters:** There is no added/unchanged/missing/removed preview or explicit removal decision. Existing missing shows are retained by accident rather than policy. Every matched TV Time reimport overwrites local user state, so a manually paused show can become caught-up from an older export.
- **Reproduction:** Pause a show locally, then reimport TV Time with `up_to_date`; state becomes `caught_up`.
- **Recommended correction:** Persist source snapshot/hash, calculate all required reimport groups, preserve explicit later local choices, and show conflicts/removal decisions before commit.
- **Impact:** **Data loss: no. Incorrect state/progress: yes. Release failure: no.**

### M10. Show details and Library omit required progress behavior

- **Severity / classification:** Medium — confirmed plan deviation.
- **Location:** `src/ui/App.tsx:36-48`.
- **Why it matters:** Show details are a flat list with no seasons, availability/release markers, mark-through, mark-season-watched, or remove action. Library lacks Ended and user-facing Needs Setup filters and required progress/schedule summaries.
- **Reproduction:** Open any show; future and aired episodes are visually indistinguishable and no season action exists.
- **Recommended correction:** Build derived season/episode view models, availability guards, required bulk actions, remove confirmation, and complete Library filters/summaries.
- **Impact:** **Data loss: no. Incorrect user decisions: possible. Release failure: yes.**

### M11. Badge and release schedule become stale after direct dashboard writes

- **Severity / classification:** Medium — confirmed defect.
- **Location:** `src/ui/useTracker.ts:19-54`; `src/imports/commit.ts:19-39`; `entrypoints/background.ts:45`; no `chrome.storage.onChanged` listener exists.
- **Why it matters:** Badge/alarm recomputation happens after background messages, but watched actions and imports write storage directly. Toolbar badge and first imported release alarm remain stale until another background event. The injected Tracker control has no badge at all.
- **Reproduction:** Mark the final backlog card watched in the dashboard and inspect the toolbar badge; no background recompute is triggered.
- **Recommended correction:** Route persistent commands through the single-writer background or subscribe to storage changes and recompute after successful relevant writes.
- **Impact:** **Data loss: no. Incorrect badge/release scheduling: yes. Release failure: no.**

### M12. Attribution is absent where core TVMaze data is displayed

- **Severity / classification:** Medium — confirmed licensing/plan deviation.
- **Location:** `src/ui/App.tsx:21-40`; attribution appears only at lines 47 and 66.
- **Why it matters:** Watch List, Upcoming, and Library display TVMaze-derived episode/show data without visible attribution. TVMaze documents CC BY-SA attribution requirements.
- **Reproduction:** Open Watch List or Upcoming; no TVMaze credit/link is visible.
- **Recommended correction:** Add visible shared dashboard attribution and retain show-level TVMaze links. Reconfirm ShareAlike/store obligations against the [official TVMaze API terms](https://www.tvmaze.com/api).
- **Impact:** **Data loss: no. Incorrect progress: no. Release/store failure: yes.**

### M13. IMDb sender validation is incomplete

- **Severity / classification:** Medium — likely defense-in-depth risk.
- **Location:** `entrypoints/background.ts:14-17`.
- **Why it matters:** When `sender.url` is undefined, the optional-chain comparison is not `false`, so the request bypasses the URL rejection even if sender ID is not the extension. No `externally_connectable` entry currently limits practical exposure, and payloads are validated, so no exploit was demonstrated.
- **Reproduction:** Call the listener with an undefined sender URL and nonmatching ID in a unit harness; the guard does not reject it.
- **Recommended correction:** Explicitly require the extension ID, classify trusted dashboard/content-script origins, and allow only commands appropriate to each sender context.
- **Impact:** **Data loss/incorrect progress: possible only if messaging becomes reachable. Release security review: yes.**

### M14. Error, pending, offline, and restore accessibility states are incomplete

- **Severity / classification:** Medium — confirmed plan deviation/accessibility defect.
- **Location:** `src/ui/App.tsx:27,47-48,55-68`; `src/ui/useTracker.ts:10-15`.
- **Why it matters:** Most async actions discard promises, remain clickable, and show no rollback/error. There is no stale/offline or last-sync state. The visible restore label wraps an input with the `hidden` attribute, removing it from the accessibility tree; a runtime accessibility check found no interactive Restore control.
- **Reproduction:** Navigate Settings by keyboard; Restore is not focusable. Cause a storage/provider write failure; the operation has no accessible error path.
- **Recommended correction:** Add real focusable controls, pending/disabled states, optimistic rollback, `role=alert`/live regions, retry actions, and stale/offline status.
- **Impact:** **Data loss: possible through unsurfaced write failures. Incorrect progress: possible. Release accessibility risk: yes.**

### M15. Compact-width layout overflows

- **Severity / classification:** Medium — confirmed accessibility defect.
- **Location:** `src/ui/styles.css:1`, `.filters` responsive rules.
- **Why it matters:** At a 320 px viewport, the dashboard measured 344 px wide due to the Library search/select row. A common 640 px window at 200% zoom has equivalent effective width.
- **Reproduction:** Open Library at 320 px; horizontal scrolling appears.
- **Recommended correction:** Give flex children `min-width:0`, allow wrapping, and stack search/filter controls at the compact breakpoint. Add viewport and zoom E2E checks.
- **Impact:** **Data loss: no. Incorrect progress: no. Release accessibility risk: yes.**

### M16. Backups/uninstall privacy limitations are not explained

- **Severity / classification:** Medium — confirmed plan/store deviation.
- **Location:** `src/ui/App.tsx:61-66`; `README.md:15-19`; no privacy document exists.
- **Why it matters:** Users are not warned that uninstalling clears local storage/IndexedDB, that backup files contain sensitive viewing history, or that identifiers/provider image/API requests go to TVMaze.
- **Reproduction:** Review Settings/About and README; no uninstall/sensitive-backup warning appears.
- **Recommended correction:** Add concise local-data, uninstall, backup-sensitivity, and TVMaze network disclosures plus a store-ready privacy policy.
- **Impact:** **Data loss risk: yes. Incorrect progress: no. Release/store risk: yes.**

## Low

### L1. Empty IMDb numeric fields become zero

- **Severity / classification:** Low — confirmed parser defect.
- **Location:** `src/imports/imdb.ts:46-50`.
- **Why it matters:** `Number("")` is zero, so blank Year/Position fields become `{year:0, position:0}` and can affect fallback ordering/diagnostics.
- **Reproduction:** Parse a supported row with blank Year and Position.
- **Recommended correction:** Parse only nonempty values and validate sensible ranges.
- **Impact:** **Data loss: no. Incorrect metadata/order: possible. Release failure: no.**

### L2. Useful raw TV Time diagnostic fields are discarded

- **Severity / classification:** Low — plan deviation.
- **Location:** `src/imports/tvtime.ts:38-45`.
- **Why it matters:** Raw special flags, `watched_count`, favorite, `_noEpisodeData`, and available show IMDb IDs are not retained, weakening conflict/special reports and future migration options.
- **Reproduction:** Inspect normalized results from the supplied ZIP; only a subset survives.
- **Recommended correction:** Preserve useful raw fields in staged import records while continuing to exclude specials from primary selectors.
- **Impact:** **Data loss: import diagnostics only. Incorrect progress: possible in edge cases. Release failure: no.**

### L3. Scheduler scans metadata for untracked/removed shows

- **Severity / classification:** Low — confirmed inefficiency.
- **Location:** `src/scheduling/sync.ts:49-54`; removal at `entrypoints/background.ts:40-42` does not clear metadata.
- **Why it matters:** Nearest-release alarm considers every cached episode, including TV Time-only metadata and removed shows, which can schedule irrelevant wakeups.
- **Reproduction:** Remove a show whose cached future episode is earliest; alarm selection still includes it.
- **Recommended correction:** Intersect episodes with currently tracked provider IDs before scheduling; optionally garbage-collect orphan cache records.
- **Impact:** **Data loss: no. Incorrect visible progress: no. Release efficiency risk: low.**

### L4. Provider response validation has small defense-in-depth gaps

- **Severity / classification:** Low — likely risk.
- **Location:** `src/providers/tvmaze/provider.ts:41-45`; `src/providers/tvmaze/schemas.ts:3-7`; `src/providers/tvmaze/client.ts:22-24`.
- **Why it matters:** Update maps accept NaN/negative values, generic URL validation does not require HTTPS/TVMaze hosts, and `Retry-After` accepts only numeric seconds, not an HTTP date.
- **Reproduction:** Supply malformed update keys/timestamps or HTTP-date Retry-After in a mock response.
- **Recommended correction:** Add strict response schemas and URL host/scheme refinement; parse both permitted Retry-After formats.
- **Impact:** **Data loss: no. Incorrect sync/backoff: possible. Release failure: unlikely.**

### L5. Extension identity/store assets are absent

- **Severity / classification:** Low — release-readiness plan deviation.
- **Location:** `wxt.config.ts:6-15`; no `public/` assets.
- **Why it matters:** Manifest/action icons and store/privacy/support assets are missing; unpacked Chrome uses a generic icon.
- **Reproduction:** Inspect the built manifest: no `icons` or action icon fields exist.
- **Recommended correction:** Add original, non-IMDb identity icons and complete store listing/privacy/support artifacts.
- **Impact:** **Data loss: no. Incorrect progress: no. Release/store failure: possible.**

### L6. Approved-plan document is not the full approved plan

- **Severity / classification:** Low — documentation deviation.
- **Location:** `docs/implementation-plan.md`.
- **Why it matters:** The saved file is a shortened baseline that delegates unstated details back to `tracker-plan-prompt.txt`; it is not the full decision-complete plan the user approved. This makes compliance review and future implementation handoff less reliable.
- **Reproduction:** Compare the approved plan from the conversation with the 49-line saved summary.
- **Recommended correction:** Replace it with the complete approved plan without changing the normative requirements.
- **Impact:** **Data loss: no. Incorrect progress: indirect risk. Release failure: no.**

## Test gaps

### TG1. The declared E2E command is broken and no E2E suite exists

- **Severity / classification:** High test gap.
- **Location:** `package.json:16`; no `playwright.config.ts` or E2E test directory.
- **Evidence:** `npm run test:e2e` exited 1. Playwright discovered Vitest files, emitted repeated “Vitest failed to access its internal state,” then reported “No tests found.”
- **Recommended correction:** Add a Playwright configuration with a dedicated test directory and deterministic unpacked-extension fixtures covering load, dashboard, import, IMDb integration, progress, release transition, and backup.
- **Impact:** **Data loss risk untested: yes. Incorrect progress untested: yes. Release failure: yes.**

### TG2. Import/matching/backup/storage reliability is essentially untested

- **Severity / classification:** High test gap.
- **Location:** `tests/` contains no tests for `commitCombinedImport`, `reconcileShows`, `mapTvTimeProgress`, storage, backup, or migrations.
- **Missing scenarios:** Exact ID lookups, conflicts/ambiguity, TV Time-only decisions, season differences, false watched precedence, unmapped reports, partial provider failure, reimport diffs, staging/recovery, concurrent writes, quota, cache rebuild, corrupt backup, version migration, merge/replace, and safety backup.
- **Recommended correction:** Add pure unit tests and mocked integration tests before changing importer behavior; retain the real fixtures as an additional schema regression suite.
- **Impact:** **Data loss and incorrect progress paths are unprotected.**

### TG3. ZIP security tests are absent

- **Severity / classification:** High test gap.
- **Location:** Only happy-path fixture coverage at `tests/integration/real-fixtures.test.ts:12-16`.
- **Missing scenarios:** Total central-directory entries, pre-decompression totals, compression ratios, encrypted archives, traversal variants, malformed DEFLATE/JSON, oversized CSV, schema variations, and main-thread responsiveness.
- **Recommended correction:** Build tiny generated hostile archives and assert early bounded rejection without materializing payloads.
- **Impact:** **Release/security DoS risk is unprotected.**

### TG4. Provider, retry, synchronization, and alarm code has no tests

- **Severity / classification:** High test gap.
- **Location:** No tests exercise `src/providers/tvmaze/*` or `src/scheduling/sync.ts`.
- **Missing scenarios:** IMDb/TVDB lookup, response validation, 404, 429/Retry-After, network/5xx, retry termination/no deadlock, concurrency/start spacing, persistent cache, changed intersection, ended shows, partial failure, 404 cache preservation, revival, corrections, stable alarms, stale-on-open sync, and cache hydration.
- **Recommended correction:** Use deterministic mocked fetch/Chrome/Dexie harnesses with fake timers and failure concurrency.
- **Impact:** **Incorrect progress and release reliability paths are unprotected.**

### TG5. Availability/selector/state tests cover only the simplest path

- **Severity / classification:** Medium test gap.
- **Location:** `tests/unit/availability.test.ts` has three tests; `tests/unit/selectors.test.ts` has one.
- **Missing scenarios:** DST gaps/overlaps, invalid airstamp fallback, timezone changes, simultaneous drops, paused/not-started/completed, caught-up/revival, specials/future exclusions, multi-show sorting/ties, watched advancement/removal, Upcoming counts, and state derivation.
- **Recommended correction:** Expand table-driven pure-domain coverage, especially around clocks and state transitions.
- **Impact:** **Incorrect progress/release timing remains likely.**

### TG6. No dashboard component/accessibility tests exist

- **Severity / classification:** Medium test gap.
- **Location:** React Testing Library is installed but unused.
- **Missing scenarios:** Action failures/pending states, history/Undo ordering, Library filters, show seasons/actions, attribution, AX names/focus order, reduced motion, contrast, compact widths, 200% zoom, and offline/stale displays.
- **Recommended correction:** Add component tests plus Playwright AX/viewport checks.
- **Impact:** **Functional/accessibility release regressions are unprotected.**

### TG7. IMDb integration has no stable DOM fixtures or automation

- **Severity / classification:** High test gap.
- **Location:** No IMDb HTML fixtures/tests exist.
- **Missing scenarios:** Header/title placement, movie suppression, SPA navigation, duplicate prevention, route cancellation, fallback placement, waiting badge, tracked menu, keyboard interaction, and network error states.
- **Recommended correction:** Add multiple versioned local IMDb DOM fixtures and mutation-heavy tests; retain a non-gating live smoke check separately.
- **Impact:** **The currently reproduced duplicate/wrong-page defects reached the build unnoticed.**

### TG8. There is no lint check

- **Severity / classification:** Low test/tooling gap.
- **Location:** `package.json:6-16`.
- **Evidence:** `npm run lint` exits 1 with “Missing script: lint.”
- **Recommended correction:** Add a non-rewriting ESLint command appropriate for React/TypeScript/WXT and run it in CI.
- **Impact:** **No direct data loss; maintenance/release quality risk.**

## Verified working behavior

The following claims were verified by code inspection, tests, builds, or an actual unpacked runtime check. Qualifications refer back to findings above.

- **Real fixtures parse:** IMDb fixture produces 184 supported rows with no malformed/unsupported/duplicate rows. TV Time produces 213 shows, 8,368 episodes, 6,090 watched records, 1,953 normalized specials, and 45 season/episode special-flag mismatches. The HTML summary is not rendered and movie JSON is not selected.
- **IMDb basic parsing:** BOM/header aliases, television-only filtering, deduplication, and Created-descending sorting work for covered cases. Missing shows are not automatically deleted.
- **Special/future backlog guard:** TV Time specials are normalized when either raw flag is true and excluded from mapped primary progress. TVMaze's regular show-episode endpoint is requested without `specials=1`; the [official endpoint documentation](https://www.tvmaze.com/api) states specials are excluded by default. Selector logic also requires `kind:"regular"` and availability.
- **Watch List core selector:** One item per eligible show; earliest season/episode-ordered aired unwatched regular episode; additional count excludes future/watched episodes; paused, not-started, completed, and progress-unknown are suppressed. Primary show sorting uses the newest release among the current backlog, descending, then title/ID.
- **Upcoming core selector:** One nearest future regular episode per show, sorted by release instant ascending. It lacks the required grouping/count precision described above.
- **Availability basics:** Exact valid airstamp takes precedence; date-only uses the configured local hour and IANA timezone; missing schedule is unknown. Exact times display through `formatInTimeZone`. DST gap/overlap policy is not correct/tested.
- **Local card advancement:** Marking the displayed episode writes watched state and reloads locally without an API request; selector recomputation advances/removes the card. History records are created, subject to Undo/storage defects.
- **Caught-up availability guard:** Show-level “Mark caught up” derives IDs through `airedUnwatched`, so it does not pre-mark future or special episodes, though it is non-atomic and final state derivation is wrong. No season action exists.
- **Storage separation:** User shows/progress/history/settings reside under one versioned `chrome.storage.local` envelope; TVMaze show/episode metadata resides in IndexedDB. `resetMetadataCache` itself does not delete local progress/history.
- **Provider basics:** Exact IMDb/TVDB show endpoint patterns are used; provider responses are schema-parsed; successful requests are start-spaced and in-flight duplicate requests are coalesced; 404 returns null and nominal retry count is bounded. Error concurrency is defective.
- **Privacy/security basics:** Built manifest is MV3 with only `storage` and `alarms`, host access limited to IMDb and TVMaze API, and packaged-code-only CSP. Static search found no telemetry, analytics, `storage.sync`, unsafe HTML injection, `eval`, or remotely hosted executable code. Provider/imported labels are rendered as React text or `textContent`.
- **IMDb data boundary:** IMDb IDs come from URL paths; no IMDb metadata/artwork scraping exists. Content UI uses closed Shadow DOM and native text buttons with accessible names. Placement/type gating/idempotency are defective.
- **Dashboard basics:** Full extension page exposes Watch List, Upcoming, Library, Import, and Settings; dark/yellow styling, visible focus rule, 44 px controls, responsive rules, reduced-motion media query, and an unofficial notice exist.
- **Backup export:** Export contains the current local user-state envelope, including mappings, progress, settings, history, and sync marker. Restore is unsafe.
- **Build artifacts:** Private fixture signatures were not found in Chrome/Edge output, and every manifest-referenced generated file exists.
- **Production dependency audit:** `npm audit --omit=dev` reported zero vulnerabilities.
- **Actual unpacked runtime:** Chrome for Testing 149, launched by Playwright with `.output/chrome-mv3`, registered the `IMDb Shows Tracker` MV3 service worker and loaded `dashboard.html#/watch-list` with the expected heading/navigation and no dashboard console/page errors. This verifies a real unpacked Chromium load, not a manual click through stable Chrome's extensions UI.

## Commands run and results

| Command/check | Result |
|---|---|
| Read `docs/tracker-plan-prompt.txt` and `docs/implementation-plan.md` | Passed; requested root prompt absent, equivalent found under `docs/` |
| Recursive `AGENTS.md` search | None found |
| `rg --files` repository inventory | 29 source/test/docs files plus fixtures/config/lockfile; `node_modules` and output excluded |
| `git status --short`, `git diff` | Could not run: workspace has no `.git` repository |
| `npm run typecheck` | **Passed**, exit 0 |
| `npm test` | **Passed**, 4 files / 8 tests |
| `npm run lint` | **Failed**, exit 1: script does not exist |
| `npm run test:e2e` | **Failed**, exit 1: Vitest files mis-discovered; no E2E tests |
| `npm run build` | **Passed**, Chrome MV3 output approximately 698 KB; dashboard chunk warning at approximately 505 KB |
| `npm run build:edge` | **Passed**, Edge MV3 output approximately 698 KB; same chunk warning |
| `npm audit --omit=dev` | **Passed**, zero production vulnerabilities |
| Real-fixture tests | **Passed** with the counts in Verified behavior |
| Built manifest/file/CSP/fixture-leak inspection | **Passed** for referenced files, MV3/CSP/minimal permissions, and no fixture signatures |
| Playwright unpacked Chrome-for-Testing launch | **Passed**: tracker service worker and dashboard loaded |
| Live IMDb title-page smoke | Content script ran, but **failed idempotency**: six duplicate roots |
| Mutation-heavy IMDb fixture | **Failed idempotency**: 82 duplicate roots in 1.5 seconds |
| Movie eligibility fixture | **Failed**: movie exposed `Track show` |
| Tracked-button smoke | **Failed**: second click did not open dashboard |
| DST wall-time probe | **Failed gap policy** for Bucharest/New York nonexistent times |
| ZIP entry-count probe | **Failed**: 10,002 total entries accepted when non-JSON entries were filtered |
| Backup validation probe | **Failed**: malformed nested/future-version state accepted |

No production files or test files were changed. Installing Playwright's Chromium browser affected only the user's external Playwright cache and was used for the unpacked runtime check.

## Build and test status

- **Chrome build:** Pass.
- **Edge build:** Pass.
- **Strict TypeScript:** Pass.
- **Current Vitest suite:** Pass, but only eight tests and far below approved coverage.
- **Lint:** Not configured.
- **E2E:** Broken/not implemented.
- **Unpacked MV3 load:** Verified in Playwright Chrome for Testing; dashboard and service worker load. Live IMDb behavior is not release-ready because duplicate injection was reproduced.
- **Overall release status:** **Not ready for production or Chrome Web Store submission.** Critical restore/Undo data-integrity defects and high import/provider/IMDb gaps must be fixed first.

## Requirements-compliance checklist

Legend: ✅ verified; ⚠️ partial/defective; ❌ missing or materially noncompliant.

### Import and matching

| Requirement | Status | Evidence |
|---|---:|---|
| Parse supplied IMDb CSV | ✅ | Real fixture 184/184 |
| Parse supplied TV Time ZIP | ✅ | 213 shows / 8,368 episodes |
| ZIP validation/bounds | ⚠️ | Basic checks exist; post-allocation and entry-count bypass |
| Exact IMDb/TVDB show lookup | ✅ | TVMaze lookup endpoints used |
| Conflict/ambiguous handling | ❌ | Declared type unused; no review/fallback |
| Exact episode ID/season variance | ❌ | Season/number only |
| Future unwatched episodes gated by provider date | ✅ | Availability selector controls backlog |
| Specials excluded from primary backlog | ✅ | Parser and provider/selector paths exclude them |
| Reimport diff/removal confirmation | ❌ | Unused incomplete helper |
| Partial-import recovery/transaction | ❌ | Partial success marked complete; no staging recovery |
| Preserve progress | ⚠️ | Generally retained, but false TV Time flags, state overwrite, races, and failures break guarantees |

### Progress behavior

| Requirement | Status | Evidence |
|---|---:|---|
| TV Time history priority | ⚠️ | True watched imports; false flags cannot override older state |
| Active IMDb-only episode review | ❌ | No onboarding flow |
| Finished two-choice bulk assumptions | ❌ | Missing |
| Mixture Created-descending review | ❌ | Parser sorts, but review UI absent |
| Choose last watched / manual gaps | ❌ | Missing |
| Not-started/paused suppress Watch List | ✅ | Selector filters both |
| Mark season watched excludes future | ❌ | No season action |
| State transitions/revivals | ❌ | No central derivation; completed never revives |

### Watch List

| Requirement | Status | Evidence |
|---|---:|---|
| One card/show | ✅ | Selector flat-maps at most one item |
| Earliest aired unwatched | ✅ | Tested |
| Additional aired-only count | ✅ | Tested |
| Local immediate advancement/removal | ⚠️ | Code path works after storage/reload; no E2E or error rollback |
| Future excluded | ✅ | Availability gate |
| Undo restores state | ❌ | Older Undo erases newer state |
| Documented sorting | ✅ | Newest backlog release, then title/ID |

### Upcoming and clocks

| Requirement | Status | Evidence |
|---|---:|---|
| One nearest future/show, chronological | ✅ | Selector implementation |
| Exact timezone conversion | ✅ | `formatInTimeZone` and instant comparison |
| Configured date-only hour | ✅ | Basic test passes |
| Simultaneous/later grouping counts | ❌ | Selector returns only one episode |
| Local release transition | ⚠️ | Recomputed on reload; open dashboard is not notified |
| Startup/dashboard recomputation | ⚠️ | UI computes on render; state/alarm/sync pathways incomplete |
| DST transitions | ❌ | No tests and gap-time conversion is wrong |

### Storage and reliability

| Requirement | Status | Evidence |
|---|---:|---|
| Separate user progress/metadata | ✅ | `chrome.storage.local` versus Dexie |
| Versioned schemas/migrations | ⚠️ | Version number exists; nested validation/migration logic absent |
| Backup/restore preserves state safely | ❌ | Destructive shallow restore |
| Cache clear preserves history | ✅ | Local state untouched |
| Cache can be rebuilt | ❌ | Sync markers can prevent hydration |
| Interrupted writes/import recovery | ❌ | No staging/recovery; concurrent lost writes |
| Uninstall limitations explained | ❌ | Missing |

### TVMaze

| Requirement | Status | Evidence |
|---|---:|---|
| Persistent API cache | ❌ | Cache table unused |
| Bounded concurrency | ⚠️ | Success path bounded; retry can deadlock |
| 404/429/retry behavior | ⚠️ | Lookup 404 and nominal retry exist; episode 404 erases cache and 429 can deadlock |
| Changed timestamps/ended-show efficiency | ❌ | Missing-map bug refetches unchanged shows |
| Provider corrections recalculate views | ⚠️ | Metadata replaces transactionally; state/open dashboard recalculation incomplete |
| Attribution | ⚠️ | Detail/Settings only, absent core pages |
| Provider HTML safety | ✅ | No provider HTML injected |

### IMDb integration

| Requirement | Status | Evidence |
|---|---:|---|
| Header Tracker placement/badge | ❌ | Fixed overlay, no badge |
| Series/miniseries-only title control | ❌ | Appears on movie fixture |
| No duplicate SPA buttons | ❌ | Six live / 82 mutation-fixture roots |
| Placement fallbacks | ❌ | None |
| IMDb IDs from URL only | ✅ | Regex path extraction |
| No IMDb metadata/artwork scraping | ✅ | Verified static inspection |
| Scoped styles | ✅ | Closed Shadow DOM |
| Tracked menu/progress actions | ❌ | Missing; second click broken |
| Keyboard/screen-reader basics | ⚠️ | Native buttons named; duplicate/missing menu undermine workflow |

### Manifest, security, privacy

| Requirement | Status | Evidence |
|---|---:|---|
| Minimal permissions/hosts | ✅ | `storage`, `alarms`, IMDb, TVMaze API only |
| No remote executable code; MV3 CSP | ✅ | Built manifest inspected |
| Safe rendering | ✅ | React/textContent; no unsafe HTML APIs |
| Isolated storage from page scripts | ✅ | Content script/runtime boundary |
| Validated messages | ⚠️ | Zod payloads; sender guard incomplete |
| No history leak to IMDb | ✅ | Status response exposes boolean/library count only |
| No telemetry | ✅ | Static/dependency search |
| Import security | ❌ | Decompression limits can be bypassed/late |

### UI, accessibility, packaging

| Requirement | Status | Evidence |
|---|---:|---|
| IMDb-inspired unofficial design | ✅ | Dark/yellow system and notice |
| Loading/empty/error/offline | ⚠️ | Basic text only; no offline/retry/action errors |
| Focus/named icon controls | ✅ | Global focus rule; watched button named |
| Contrast | ⚠️ | Tokens appear reasonable; no formal automated audit |
| Responsive/zoom | ❌ | Verified 320 px overflow |
| Reduced motion | ✅ | Media query present |
| Chrome and Edge builds | ✅ | Both passed |
| Unpacked MV3 load | ✅ | Verified in Chrome for Testing |
| Lint/E2E/store readiness | ❌ | Missing/broken tests and assets |

## Five most important fixes, in priority order

1. **Protect user data first:** replace shallow destructive restore, serialize all persistent writes, redesign history as compact revision-aware deltas, and make bulk progress atomic.
2. **Build the staged import/onboarding pipeline:** analysis, exact/conflict/ambiguity review, TV Time precedence including false flags, episode mapping, finished/active setup, preview, commit markers, and recovery.
3. **Repair provider/synchronization reliability:** iterative retry without slot deadlock, persistent cache, correct changed-ID intersection, per-show failure isolation, typed 404 behavior, cache hydration, and stable alarms.
4. **Replace the IMDb overlay with tested idempotent adapters:** synchronous host reservation, header/title placement fallbacks, television gating, waiting badge, tracked menu, and correct post-add navigation.
5. **Establish a real quality gate:** dedicated Playwright suite, provider/import/storage integration tests, DST/state/Undo tests, lint, accessibility/zoom checks, and built-manifest/load smoke tests.

## Proposed sequence of small fix batches

1. **Batch A — Data integrity guardrails:** strict backup schemas; safe merge/replace preview; single-writer queue; compact latest-only/delta Undo; atomic bulk action; surfaced storage errors.
2. **Batch B — Provider primitives:** iterative retry/concurrency tests; typed API results; persistent TTL cache; corrected update intersection; per-show sync isolation; forced missing-cache hydration.
3. **Batch C — Import analysis only:** durable staged records, robust file/schema validation in a worker, exact show/episode matching, conflict/ambiguity/unmatched report, reimport diff. Do not commit progress yet.
4. **Batch D — Onboarding and commit:** finished assumptions, mixture/Created ordering, active progress actions, TV Time-only choices, final preview, transactional markers, recovery, and reimport precedence.
5. **Batch E — Domain/state/history:** central transitions, completed revival, caught-up/completed derivation, season/through actions, DST policy, timezone changes, and open-dashboard release notifications.
6. **Batch F — IMDb integration:** placement adapters, duplicate race fix, route/type gating, badge/menu, keyboard states, and stable local DOM fixtures.
7. **Batch G — Dashboard completion:** season detail UI, Library filters/summaries, Upcoming grouping/precision, attribution, offline/error states, uninstall/privacy copy, compact-width fixes.
8. **Batch H — Release gate:** lint, unit/integration/E2E suites, Chrome/Edge unpacked smoke tests, dependency/CSP audit, icons/privacy/store artifacts, and final manual accessibility review.

Stop after each batch for focused review. Do not combine import behavior changes with storage/Undo changes in one large patch; the data-integrity foundation should land and be tested first.
