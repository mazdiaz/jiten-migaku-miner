# Read-Only AnkiConnect Decision Sync Design

- Date: 2026-09-10
- Baseline: `main` at `183f6926c6410b4833468098878085b6b071956d`
- Scope: use the user's current Anki collection to automatically derive Jiten Miner `Known` / `Mined` decisions while preserving manual overrides
- Integration boundary: read-only AnkiConnect on Anki Desktop

## Context

Jiten Miner currently requires the user to mark each target word manually as `Known`, `Mined`, `Skip`, or `Later`. For a user with thousands of existing Anki vocabulary cards, most of those decisions duplicate information Anki already has.

The feature should make the decision workflow mostly about genuinely unresolved words. The user opens Anki Desktop, asks Jiten Miner to sync, reviews a summary, and applies the result. Existing Anki cards are never modified.

The current application already has useful boundaries for this work:

- manual word decisions are persisted separately from imported Migaku known-word data;
- query and coverage calculation happen in the worker;
- `canonicalWord()` is the shared lexical identity helper;
- IndexedDB and memory storage implement common ports;
- backup/restore already treats user state as a coordinated unit;
- a successful manual decision removes that word from the mining queue.

The Anki integration should extend those boundaries rather than turn Anki state into thousands of simulated button presses.

## Goals

1. Read selected cards from Anki Desktop through AnkiConnect.
2. Automatically derive only two Anki statuses: `Known` and `Mined`.
3. Make manual Jiten Miner decisions higher priority than Anki-derived status.
4. Persist the last successful Anki snapshot so the app remains useful while Anki is closed.
5. Preview a complete sync before any stored state changes.
6. Replace Anki-derived state atomically after explicit user approval.
7. Keep query filters, coverage, review, queue behavior, and visible status consistent with the same effective-decision rules.
8. Keep the integration structurally read-only: no Jiten Miner API exposes an Anki write action.
9. Allow note type, deck scope, and target field to change later without code changes.
10. Preserve compatibility with existing stored data and old backups.

## Non-Goals

Version 1 does not:

1. add, edit, delete, suspend, unsuspend, reset, reschedule, or otherwise modify Anki cards or notes;
2. change card due dates or reset cards to New;
3. sync automatically on application startup or in the background;
4. import definitions, example sentences, audio, images, review history, or other Anki note content;
5. support arbitrary user-configurable Anki-state mappings;
6. support multiple independent note-type/field mappings in one sync;
7. make AnkiConnect a required dependency for normal Jiten Miner use;
8. require Anki to remain open after a successful snapshot has been applied;
9. introduce a backend, account, cloud sync, or telemetry;
10. optimize around worker-side Anki snapshot caching before profiling shows it is needed.

## Confirmed User Behavior

The initial configuration will normally point at the user's mining setup, currently:

- note type: `Diaz Custom Mine`;
- deck: `MAIN::Mining`;
- target field: `Target Word (no syntax)`.

These values are examples of the user's current configuration, not constants in source code. The UI discovers available decks, note types, and fields through AnkiConnect and persists the user's selections.

The user can choose either a specific deck or `All decks using this note type`. A specific deck is the normal first setup, while all-decks scope allows cards to move between decks without losing recognition.

### Status mapping

The agreed v1 mapping is:

| Anki card state | Jiten Miner Anki status |
| --- | --- |
| New and not suspended | `Mined` |
| Learning | `Known` |
| Young / normal review | `Known` |
| Mature | `Known` |
| Relearning | `Known` |
| Suspended, regardless of underlying state | `Known` |

The implementation should avoid coupling domain logic to Anki's internal numeric queue/type values. It derives the Mined set by Anki search semantics: selected cards that are New and not suspended. Every other selected card is Known.

If multiple selected cards resolve to the same canonical target word, `Known` wins over `Mined`.

A word that is absent from the last successful Anki snapshot has no Anki-derived decision.

## Chosen Architecture

Anki is a separate decision layer, not a source field added to the existing manual `WordDecision` record.

The three relevant sources of state are:

```text
Migaku known-word set     -> independent knownness source
Manual Jiten decisions    -> known / mined / skip / later
Anki snapshot             -> known / mined only
```

Manual and Anki decisions combine into one effective decision:

```text
effectiveDecision(word) =
  manualDecision(word)
  ?? ankiStatus(word)
  ?? "unreviewed"
```

The source is retained for UI and behavior:

```text
decisionSource(word) =
  manualDecision exists ? "manual"
  : ankiStatus exists    ? "anki"
  : null
```

Knownness remains compatible with the existing Migaku known-word set:

```text
knownByMigaku   = importedKnownWords contains word
knownByDecision = effectiveDecision === "known"
known           = knownByMigaku || knownByDecision
```

This means a manual `Mined`, `Skip`, or `Later` overrides an Anki `Known` status for the decision layer and does not become known merely because Anki says Known. The independently imported Migaku known-word set still retains its existing authority: if the same word is in that set, `known` remains true.

Removing a manual override does not manufacture an `unreviewed` record. It removes the manual record and reveals the current Anki status underneath. For example:

```text
Manual: Mined
Anki:   Known
Shown:  Mined · Manual

remove manual override

Manual: —
Anki:   Known
Shown:  Known · Anki
```

This separation keeps manual intent durable across future Anki syncs while allowing Anki-generated `Mined` to naturally become Anki-generated `Known` after the card has been studied.

## Domain Types

Add a narrow Anki-derived status type:

```text
type AnkiWordStatus = "known" | "mined"
type DecisionSource = "manual" | "anki" | null
```

Keep the existing manual `WordDecision` shape unchanged unless another implementation requirement independently justifies changing it. Its presence means the decision is manual.

Extend `EntryWithKnown` so every downstream consumer can see the effective result and its source:

```text
EntryWithKnown {
  ...existing fields
  decision: WordDecisionStatus | "unreviewed"
  decisionSource: "manual" | "anki" | null
  knownByMigaku: boolean
  knownByDecision: boolean
  knownByAnki: boolean
  known: boolean
}
```

`knownByAnki` is true only when the effective decision source is Anki and the effective decision is `known`. An Anki `Known` hidden under a manual override must not independently leak back into `known`.

Create pure domain helpers for:

- resolving effective decision and source from manual + Anki layers;
- aggregating duplicate Anki card statuses with `Known > Mined` precedence;
- calculating knownness consistently for query and coverage code.

Both query and coverage must use the same helper rather than independently reimplement precedence.

## AnkiConnect Platform Boundary

Create a narrow read-only platform port and implementation, for example:

```text
AnkiConnectPort
  requestPermission()
  deckNames()
  modelNames()
  modelFieldNames(noteType)
  findCards(search)
  cardsInfo(cardIds)
```

The concrete browser adapter talks only to the default local AnkiConnect endpoint:

```text
http://127.0.0.1:8765
```

Use AnkiConnect API version 6 requests. Response parsing is strict: malformed envelopes, unexpected result types, and non-null AnkiConnect errors become typed adapter errors.

The adapter owns Anki search-string quoting/escaping. UI or service code must never concatenate raw deck/note-type values into search syntax itself.

### Permission

First setup calls `requestPermission`. If permission is denied, setup stops without changing existing config or snapshot.

If AnkiConnect reports that an API key is required, v1 reports an actionable unsupported-configuration error and performs no sync. V1 does not add API-key storage.

### Read-only guarantee

The port exposes no Anki mutation methods. There is no `addNote`, `updateNoteFields`, `changeDeck`, `suspend`, `unsuspend`, `forgetCards`, `setDueDate`, or equivalent operation in the Jiten Miner Anki adapter.

This is an architectural guarantee, not merely a disabled UI button.

## Configuration

Persist an `AnkiSyncConfig` separately from general view/query preferences:

```text
AnkiSyncConfig {
  deckScope:
    | { kind: "deck", name: string }
    | { kind: "all-decks" }
  noteType: string
  targetField: string
}
```

Setup flow:

1. Request permission.
2. Load deck names and note types.
3. User selects deck scope and note type.
4. Load field names for that note type.
5. User selects the target-word field.
6. `Check configuration` validates that the current Anki collection still contains the selected values.
7. Save the validated config locally.

If a previously saved deck, note type, or field disappears later, sync fails non-destructively and the UI asks the user to revisit settings.

Configuration changes invalidate any pending preview.

## Scan Algorithm

A sync scan is read-only and builds a complete candidate snapshot in memory before preview.

1. Validate connection, permission, and saved configuration.
2. Build the base Anki search from note type plus optional deck scope.
3. `findCards(baseQuery)` returns all selected card IDs.
4. `findCards(baseQuery + New + not suspended)` returns the subset that should be `Mined`.
5. Fetch `cardsInfo` for all selected card IDs in bounded batches of 500.
6. For each returned card:
   - require the configured target field;
   - read and trim the field's raw string value;
   - ignore empty values and count them for diagnostics;
   - canonicalize with the existing `canonicalWord()` helper;
   - classify the card as `Mined` if its ID is in the New/not-suspended set, otherwise `Known`;
   - merge duplicate canonical words using `Known > Mined`.
7. Do not persist anything yet.
8. Compute preview information.
9. Present the candidate to the user.

No full Anki card objects, card IDs, definitions, or unrelated note fields are persisted. The persistent snapshot contains only canonical target words, derived status, sync timestamp, and summary metadata.

If Anki returns zero selected cards, the scan is still valid but the preview must present a destructive-empty warning before Apply.

## Preview

A successful scan produces a temporary `AnkiSyncPreview` owned by `AnkiSyncService`.

At minimum the UI shows:

```text
Anki Sync Preview

4,218 cards scanned
3,900 unique target words
3,640 match the current Jiten dataset
2,910 matched words -> Known
623 matched words -> Mined
107 manual decisions protected
N queued words will be removed
M cards had an empty/invalid target field

[ Cancel ]    [ Apply Sync ]
```

Exact values are derived from real data; the above is illustrative.

If no Jiten dataset is active, sync is still allowed. The preview says that the snapshot will be saved for future datasets and omits dataset-match counts.

Dataset matching can require scanning up to 100,000 Jiten rows. That calculation stays in the worker. Add a protocol operation for preview matching rather than reading every dataset row and performing an O(n) scan on the main thread.

The worker preview response should provide the unique current-dataset counts needed by the UI, including:

- Anki candidate words matching the active dataset;
- effective matched `Known` count;
- effective matched `Mined` count;
- matched words protected by a manual decision.

Queue-removal count is derived by intersecting the current in-memory queue with candidate effective decisions and does not require a full dataset scan.

Cancel discards the candidate and has no persistent effect.

## Apply Semantics

Apply is one coordinated user-state mutation, not thousands of calls to `setWordDecision()`.

On Apply:

1. Verify the preview is still current for the saved config, active dataset, and user-state epoch.
2. Acquire the existing user-state lock.
3. Re-check the epoch after acquiring the lock.
4. Atomically replace the persistent Anki snapshot.
5. Replace `AnkiSyncService`'s in-memory snapshot only after storage succeeds.
6. Remove mining-queue entries whose new effective decision is now `Known` or `Mined` through Anki, unless a manual override keeps the word in a different effective state.
7. Clear the one-step manual undo record because a bulk state-layer change can make its saved queue context stale.
8. Count the entire successful sync as one backup-relevant change.
9. Publish lightweight Anki summary state.
10. Run the normal query once.
11. Recalculate coverage once.

Do not execute query/coverage refresh once per Anki word.

If any persistence step fails, the previous persistent snapshot, previous in-memory snapshot, queue, and visible effective statuses remain unchanged.

A later successful sync completely replaces the previous Anki snapshot. Therefore, a word removed from the selected Anki scope loses its Anki-derived status and becomes `Unreviewed` unless it has a manual decision or another independent knownness source.

If Anki is unavailable or a scan fails, do not clear or age out the previous snapshot.

## Service Boundary And App State

Create an `AnkiSyncService` that owns:

- the loaded configuration;
- the loaded full Anki snapshot map;
- connection/sync orchestration;
- temporary preview candidate;
- apply/clear operations.

Do not put the full Anki `Map` into published `AppState`. `snapshotAppState()` clones public app state for subscribers, and repeatedly cloning thousands of Anki words would add cost to unrelated UI updates.

Expose only lightweight UI state, for example:

```text
AnkiUiState {
  configured: boolean
  status: "idle" | "connecting" | "syncing" | "preview" | "error"
  lastSyncedAt: string | null
  wordCount: number
  knownCount: number
  minedCount: number
  errorMessage: string | null
}
```

The controller facade exposes high-level operations rather than raw AnkiConnect methods, for example:

```text
requestAnkiSetup()
validateAndSaveAnkiConfig(config)
previewAnkiSync()
applyAnkiSync()
cancelAnkiSyncPreview()
clearAnkiSyncData()
```

The UI never receives the AnkiConnect transport object.

Saving changed Anki config counts as one backup-relevant state change. Connection attempts, previews, and preview cancellation count as zero. Applying a snapshot counts as one regardless of how many words changed.

## Persistence

Add a dedicated `AnkiSyncStore` to the storage contracts rather than reusing `WordDecisionStore`.

Suggested contract:

```text
AnkiSyncStore {
  loadConfig(): Promise<AnkiSyncConfig | null>
  saveConfig(config: AnkiSyncConfig): Promise<void>
  loadSnapshot(): Promise<AnkiSyncSnapshot | null>
  replaceSnapshot(snapshot: AnkiSyncSnapshot): Promise<void>
  clear(): Promise<void>
}
```

A snapshot is conceptually:

```text
AnkiSyncSnapshot {
  syncedAt: string
  statuses: Array<[canonicalWord, "known" | "mined"]>
}
```

A single snapshot record is acceptable for v1 and gives simple atomic replacement. The expected scale is thousands to low tens of thousands of words, not the 100,000-row Jiten dataset. If profiling later shows record-size or structured-clone limits, a generation-pointer/chunked representation can replace the implementation behind the same store contract.

### IndexedDB

Bump the IndexedDB schema version from 2 to 3.

Create a new Anki sync object store during upgrade without rewriting or deleting existing dataset, entry-chunk, known-word, preference, metadata, or manual-decision records.

Upgrade tests must start from a real v2-shaped database and verify all existing state survives while the new store is created empty.

`clearAll()` includes Anki configuration and snapshot.

The memory store implements identical behavior.

## Backup And Restore

Anki config and the last successful snapshot are backup-relevant user state.

Bump exported backup format from version 1 to version 2 and include an optional/nullable Anki sync section containing validated config plus snapshot.

The parser remains backward compatible:

- backup v1 is accepted and normalized to `ankiSync: null`;
- backup v2 validates canonical words, allowed statuses, timestamps, and config values;
- exporter emits v2 only.

Restoring a v1 backup clears current Anki sync state rather than preserving unrelated newer Anki data. Restore represents the complete user-state world encoded by the backup, not a merge.

Extend the existing atomic restore snapshot so known words, manual decisions, preferences, and Anki sync state commit together. A failed restore must not leave old manual decisions paired with a newly restored Anki snapshot or vice versa.

## Worker Protocol

Bump `WORKER_PROTOCOL_VERSION` from 2 to 3 because query, coverage, and preview message shapes change materially.

For query and coverage, keep the two decision layers explicit:

```text
knownWords: string[]
manualDecisions: Array<[string, WordDecisionStatus]>
ankiStatuses: Array<[string, AnkiWordStatus]>
```

The worker resolves effective decision and knownness through the shared domain helper.

Do not pre-merge Anki into the imported Migaku known-word set. Doing so would make a manual `Mined` override unable to suppress Anki-derived Known behavior.

Add an Anki-preview dataset-match request/response so current-dataset preview counts stay off the main thread.

Protocol validation rejects:

- unknown Anki statuses;
- malformed tuple shapes;
- empty/non-string canonical keys;
- invalid protocol version;
- malformed preview requests/results.

Because the existing app already sends known-word and manual-decision collections with query requests, v1 keeps the same explicit-state-per-query model for Anki statuses. Do not introduce hidden worker-side user-state caching without profiling evidence.

## Query, Coverage, Filters, And Review

Every downstream feature uses the same effective-decision resolver.

Required behavior:

- `Decision = Known` includes effective manual Known and effective Anki Known;
- `Decision = Mined` includes effective manual Mined and effective Anki Mined;
- `Unreviewed` excludes any word with an effective manual or Anki decision;
- `hideKnown` hides effective Known words from either manual or Anki, plus existing Migaku-known words;
- manual `Mined`, `Skip`, or `Later` suppresses hidden Anki Known for the decision layer;
- coverage counts effective Anki Known exactly as query knownness does;
- review mode uses effective status when determining what remains;
- a manual action during review creates a normal manual decision and therefore overrides the Anki layer;
- removing that manual decision reveals the Anki layer again.

The existing one-step undo remains a manual-decision undo. If the prior state had no manual record but an Anki status existed, undo removes the manual override and reveals the Anki status. It must not persist the Anki status as a new manual decision.

## Queue Interaction

Existing manual decisions remove a word from the mining queue. Applying an Anki snapshot should preserve that semantic for automatically resolved `Known` / `Mined` words.

The preview reports how many current queue entries will be removed.

Apply computes the post-sync effective status after manual precedence. Remove a queued word only when its new effective status is `Known` or `Mined` due to the Anki layer. A manual `Skip`, `Later`, `Mined`, or `Known` already owns its own existing behavior and must not be reinterpreted by the Anki sync.

Queue mutation and snapshot replacement are treated as one application-level operation. If persistence fails, do not partially clear the queue.

## UI

Add an `Anki Sync` section near the existing data/import controls.

### Unconfigured

```text
Anki Sync
Automatically classify words from your Anki collection.

[ Connect to Anki ]
```

### Setup

```text
Deck scope
[ MAIN::Mining                    v ]

Note type
[ Diaz Custom Mine                v ]

Target word field
[ Target Word (no syntax)         v ]

[ Check configuration ]
```

The dropdown contents come from AnkiConnect. No user-specific value is hard-coded.

### Configured idle state

```text
Anki Sync
MAIN::Mining · Diaz Custom Mine
Target Word (no syntax)
Last synced: 10 Sep, 10:42
3,900 words · 3,120 Known · 780 Mined

[ Sync from Anki ]    [ Settings ]
```

### Effective source indicator

Where a word decision is shown, expose a subtle source label:

```text
Known · Anki
Mined · Anki
Known · Manual
```

Do not add source labels to unrelated controls or make the result list visually noisy.

### Clear action

Anki settings include `Clear Anki sync data…` with confirmation. It removes saved Anki config and snapshot, returns Anki-derived words to their underlying manual/unreviewed/Migaku-known state, clears stale preview, counts as one backup-relevant change, and refreshes query + coverage once.

Existing global `Clear saved data…` also clears Anki sync data.

## Failure Handling

All failures are non-destructive until Apply, and Apply itself is atomic at the app/storage boundary.

Required cases:

- Anki Desktop closed / connection refused: keep last snapshot and show an actionable message.
- AnkiConnect not installed: same non-destructive connection error; suggest installing/enabling AnkiConnect.
- permission denied: do not save new config or alter snapshot.
- API key required: show that API-key-protected AnkiConnect is unsupported in v1; alter nothing.
- saved deck missing: direct user to Settings; keep snapshot.
- saved note type missing: direct user to Settings; keep snapshot.
- target field missing: direct user to Settings; keep snapshot.
- malformed AnkiConnect response: typed error; keep snapshot.
- one `cardsInfo` batch fails: discard entire candidate; keep snapshot.
- empty target fields: skip those cards, report count; do not fail whole sync.
- zero selected cards: show explicit warning before Apply.
- zero matching Jiten words but non-empty Anki snapshot: allow Apply with a clear message; snapshot may be useful for a future dataset.
- storage failure during Apply: preserve previous snapshot and queue; show retryable error.
- Anki unavailable after a prior successful sync: continue using the last saved snapshot.

Use bounded request timeouts so a dead AnkiConnect endpoint cannot leave the UI indefinitely in `connecting` or `syncing`. `cardsInfo` batching provides natural cancellation/check points.

## Concurrency And Stale Preview Safety

A preview is tied to:

- the config revision used to scan;
- the active dataset ID used for preview counts, if any;
- the current user-state epoch.

Changing config, clearing/restoring data, switching/replacing dataset, or beginning a new Anki scan invalidates the previous preview.

Apply acquires the existing user-state lock and re-checks the epoch before mutation. If the preview is stale, Apply refuses and asks the user to run the preview again.

The network scan itself does not hold the user-state lock.

## Performance

Expected Anki scale is thousands to low tens of thousands of cards.

- `findCards` returns IDs only.
- `cardsInfo` is fetched in batches of 500.
- duplicate status aggregation uses a `Map` keyed by canonical word.
- full candidate snapshot stays in service memory only until Apply/Cancel.
- full Anki snapshot is not published through `AppState`.
- current-dataset matching runs in the worker.
- Apply writes the snapshot once, publishes once, queries once, and requests coverage once.

The feature must not perform one IndexedDB transaction, worker query, render, or coverage calculation per Anki word.

## Privacy And Network Boundary

Jiten Miner remains local-first.

The only new network target is the user's local AnkiConnect listener on `127.0.0.1:8765`. No Anki data is sent to a remote service.

Persist only:

- selected deck/note-type/field config;
- canonical target words;
- derived `Known` / `Mined` status;
- sync timestamp and lightweight summary metadata.

Do not persist full cards, card IDs, all note fields, or review history.

The supported v1 environment is the existing local HTTP launcher/development origin. Remote HTTPS hosting compatibility with a local HTTP AnkiConnect endpoint is not a v1 requirement.

## Testing

### Domain

Cover:

- New/not-suspended -> `Mined`;
- every other selected card -> `Known`;
- suspended New -> `Known`;
- duplicate card statuses use `Known > Mined`;
- canonical-word merging;
- manual decision precedence over Anki;
- removing manual override reveals Anki;
- Migaku known-word set remains independent;
- query and coverage helpers resolve identical knownness.

### Platform / AnkiConnect adapter

Mock HTTP and cover:

- permission granted/denied;
- API key required;
- deck/note-type/field discovery;
- correct quoted/escaped search construction;
- malformed response envelope;
- AnkiConnect `error` response;
- connection failure and timeout;
- multi-batch `cardsInfo`;
- missing target field;
- empty target field;
- read-only public interface contains no mutation operations.

### Sync service

Cover:

- scan builds candidate without mutating live snapshot;
- Cancel discards candidate;
- Apply atomically replaces snapshot;
- failed scan keeps previous snapshot;
- failed batch keeps previous snapshot;
- failed storage write keeps snapshot and queue unchanged;
- later sync removes words no longer in selected scope;
- manual decisions are protected;
- preview becomes stale after config/dataset/epoch changes;
- zero-card warning;
- queue removal count and final queue behavior;
- one successful Apply increments backup freshness once.

### Storage

Cover memory + IndexedDB parity:

- config round-trip;
- snapshot round-trip;
- snapshot replacement;
- clear;
- v2 -> v3 IndexedDB upgrade preserves all existing stores and records;
- global clear removes Anki state;
- atomic restore includes Anki state.

### Backup

Cover:

- v2 export/import round-trip with Anki state;
- old v1 backup restores with `ankiSync: null`;
- malformed statuses/config/canonical keys are rejected;
- failed restore is atomic;
- restoring v1 clears previously existing Anki state.

### Worker

Cover:

- protocol v3 validation;
- Anki `Known` / `Mined` affects decision filters;
- manual override wins;
- `hideKnown` respects effective knownness;
- Anki Known under manual Mined does not leak into knownness;
- Migaku knownness remains independent;
- coverage matches query knownness;
- preview match counts on duplicate/canonical words;
- cancellation/stale-generation behavior for preview scans.

### UI

Cover:

- unconfigured/connect/setup states;
- discovered select values;
- saved configuration restoration;
- configured idle summary;
- sync progress;
- preview counts;
- zero-result warning;
- Apply/Cancel;
- settings validation errors;
- `Known · Anki` / `Mined · Anki` / manual source labels;
- clear-Anki confirmation;
- Anki failure leaves existing visible effective status intact.

### Browser E2E

CI does not require a real Anki installation. Browser tests intercept/mock the AnkiConnect endpoint with CORS-compatible responses and verify one complete setup -> preview -> Apply workflow plus an unavailable-Anki workflow. Existing Chromium/Firefox/WebKit and production-serving suites remain green.

## Acceptance Criteria

1. With Anki Desktop + AnkiConnect running, the user can configure deck scope, note type, and target field without editing source code.
2. Sync never calls an Anki mutation action.
3. Unsuspended New cards derive `Mined`; all other selected cards derive `Known`; duplicate Known wins.
4. A scan never changes persistent Jiten Miner state before explicit Apply.
5. Manual decisions always override Anki-derived decisions across later syncs.
6. Removing a manual override reveals the current Anki-derived decision.
7. A failed or unavailable Anki sync leaves the last successful snapshot active and unchanged.
8. Apply atomically replaces the Anki snapshot and refreshes query/coverage once, not per word.
9. Effective Anki status is respected consistently by decision filters, `hideKnown`, review, coverage, and source labels.
10. Queue entries newly resolved by the Anki layer are removed only on Apply, with the count visible in preview.
11. The full Anki snapshot is not copied through every `AppState` publication.
12. IndexedDB v2 data upgrades to v3 without losing datasets, entries, known words, preferences, or manual decisions.
13. Backup v2 preserves Anki config/snapshot, while backup v1 remains restorable and produces empty Anki state.
14. Closing Anki after a successful sync does not remove classifications.
15. `Clear Anki sync data…` and global clear remove the appropriate Anki state safely.
16. Unit, storage, worker, UI, browser, lint, typecheck, and production build checks pass.

## Risks And Trade-offs

- AnkiConnect is a local add-on dependency and can be unavailable or misconfigured. Last-successful-snapshot semantics make that a recoverable condition rather than a data-loss event.
- Sending thousands of Anki tuples alongside known words/manual decisions increases worker message size. This keeps worker requests explicit and avoids hidden synchronization state; optimize only if profiling shows a real problem.
- A single IndexedDB snapshot record is intentionally simple. It is sufficient for expected vocabulary scale and gives strong replacement atomicity, but the store interface leaves room for a chunked implementation later.
- Manual decisions overriding Anki means Jiten Miner can intentionally disagree with Anki. Source labels make the reason visible.
- An imported Migaku known-word set remains an independent knownness source. A manual override cannot make such a word unknown unless that existing product behavior is redesigned separately.
- Local HTTP AnkiConnect can conflict with remote HTTPS-hosted browser security rules. V1 targets the project's existing localhost launcher rather than expanding deployment requirements.

## Implementation Boundary

This design is complete enough to plan implementation. The implementation plan should preserve these boundaries:

```text
src/domain/      effective decision + Anki status rules
src/platform/    read-only AnkiConnect transport
src/storage/     AnkiSyncStore + IndexedDB v3 + memory parity
src/app/         AnkiSyncService + lightweight AppState summary
src/worker/      protocol v3 + effective query/coverage + preview matching
src/ui/          setup, status, preview, source labels
backup/restore   format v2 + backward-compatible v1 parser
```

Implementation should proceed test-first and should not mix unrelated refactors into this feature.