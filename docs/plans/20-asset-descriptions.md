# Plan 20 — Asset Descriptions

> **Status (2026-06-16): Implemented.** Built end-to-end against the contracts
> below: the AI call (`packages/core/src/ai/describe-asset.ts`), the reconcile +
> privacy gate (`packages/core/src/actions/asset-description.ts`,
> `packages/core/src/indexing/asset-refs.ts`), the watcher carve-out
> (`apps/desktop/src-tauri/src/watcher.rs`), the single-flight controller
> (`apps/desktop/src/lib/asset-describe-controller.ts`) mounted by
> `apps/desktop/src/providers/asset-describe-provider.tsx`, and the Settings
> control (`describeAssets` setting + `apps/desktop/src/components/settings/
> describe-assets-field.tsx` + `apps/desktop/src/lib/asset-backfill.ts`).
> Decisions D1 (auto-describe **on** for new assets) and D5 (index-candidate +
> live recheck) landed as recommended. A post-release add-on in the spirit of
> [Plan 18 — Tasks](18-tasks.md): an opt-in enrichment layer on top of the
> shipped storage/index/AI spine, not part of the first wave.

**Goal:** Give every eligible image and PDF under a graph's `assets/` a local
markdown **description file** holding an AI-generated summary plus any
OCR/extracted text — so asset contents become portable, greppable, and ready for
future search indexing, **without** changing the current note index and
**without** ever sending a private or unreferenced asset to a provider.

**Depends on:** Plan 02 (graph + `assets/`), Plan 03 (markdown/frontmatter model),
Plan 04 (file watcher + index), Plan 10 (BYOK AI providers, keychain, the
`private: true` hard block). Reuses the Plan 11 capture-enrichment machinery
almost verbatim.

**Unlocks:** v2 asset indexing (described assets become a search corpus). v1 only
*produces* the descriptions; indexing them is explicitly out of scope.

**Architecture:** all policy (eligibility, privacy, AI calls, description writes)
lives in `@reflect/core`; the desktop app owns the watcher trigger, the
single-flight controller, and the Settings UI. This mirrors capture
([`actions/capture.ts`](../../packages/core/src/actions/capture.ts) +
[`lib/capture-controller.ts`](../../apps/desktop/src/lib/capture-controller.ts))
and audio memos
([`actions/audio-memo.ts`](../../packages/core/src/actions/audio-memo.ts) +
[`lib/transcription-reconciler.ts`](../../apps/desktop/src/lib/transcription-reconciler.ts)).

## Scope

**In:**

- Description generation for `png`, `jpg`/`jpeg`, `gif`, `webp`, `svg`, and `pdf`
  files under `assets/`.
- Description path: append `.reflect.md` (`assets/diagram.png` →
  `assets/diagram.png.reflect.md`).
- Managed-description frontmatter (source path, source hash, source size, provider,
  model, generation timestamp) + a managed marker. Rewrite a managed description only
  when the source hash changes; **never** overwrite a user-authored markdown file
  at that path.
- One-shot multimodal BYOK call: images as image inputs, PDFs as file inputs, SVG
  as text; returns a concise description plus OCR/extracted text when present.
- Privacy gate: read live note markdown; process an asset **only** if referenced
  by ≥1 non-private note and by **0** private notes. Skip unreferenced assets.
- Event-driven processing of newly observed eligible asset changes (and relevant
  note changes), single-flight, generation-pinned, abortable on graph switch.
- Explicit manual backfill ("Describe existing assets" in Settings) with a cost
  warning and progress, running the same processing path in backfill mode.

**Out (v1):**

- **No automatic backfill** on graph open or provider connection. Existing graphs
  may hold many large/costly assets; backfill is manual only.
- **No description retraction.** If a description exists and the asset later becomes
  private/ambiguous, the description is left untouched in v1. v2 indexing must
  reapply the privacy gate at *index* time before using a description.
- **No new index tables / projection changes.** Descriptions live on disk under
  `assets/` (which is not indexed) and are not added to the note index, backlinks,
  or search in v1.
- **No failure descriptions.** Permanent provider refusals are logged only; nothing is
  written. Auth/network errors stop the pass for a later retry.
- Video/audio assets (audio already has its own memo/transcription path).
- Downscaling/transcoding oversized assets (cap-and-skip in v1; see Risks).

## Why this shape

V1 of Reflect called a Reflect-hosted image-description API. V2 must not (no
Reflect-hosted APIs). The capture flow already inverted this correctly: the
desktop app makes BYOK calls directly, gates `private`, and writes results
locally. This plan reuses that exact spine. The one genuinely new surface is the
**description file** — a portable, user-inspectable markdown artifact that sits next
to the asset and travels with the graph folder (the portability contract).

## Contracts

### Description file

Path: `<assetRelPath>.reflect.md`. Example: `assets/diagram.png.reflect.md`.

```markdown
---
reflectAsset: true
source: assets/diagram.png
sourceHash: 9f2c…            # sha256 hex of the source bytes (hashContent)
sourceSize: 18432            # bytes
provider: anthropic
model: claude-opus-4-8
generatedAt: 2026-06-16T12:34:56.000Z
---

A flow diagram showing the capture pipeline: browser extension → native host →
inbox → desktop drain.

## Extracted text

Capture → Inbox → Drain → Enrich
```

- **`reflectAsset: true` is the managed marker.** Detection rule:
  - File absent → generate.
  - File present, parses with `reflectAsset === true` → **managed**; regenerate
    iff `sourceHash` ≠ current source hash, else skip (up to date).
  - File present **without** the marker → **user-authored**; never read for
    decisions, never overwrite, never delete.
- Frontmatter written via
  [`upsertFrontmatter`](../../packages/core/src/markdown/frontmatter.ts) (minimal
  diff, tolerant); the body is our generated markdown. The "## Extracted text"
  section is included only when the model returns OCR/extracted text.

### AI module — `packages/core/src/ai/describe-asset.ts`

A near-clone of [`describe-page.ts`](../../packages/core/src/ai/describe-page.ts),
same error contract:

```ts
export interface DescribeAssetRequest {
  config: AiProviderConfig          // app default (see resolution below)
  apiKey: string                    // from keychain
  fetchFn?: typeof fetch            // providerFetch (Tauri HTTP); tests stub
  kind: 'image' | 'pdf' | 'svg'
  mediaType: string                 // e.g. image/png, application/pdf
  /** base64 (no data-URL prefix) for image/pdf; raw UTF-8 source for svg */
  data: string
  filename: string                  // for the prompt + provider hints
}

/** Concise description + OCR/extracted text as markdown. */
export async function describeAsset(request: DescribeAssetRequest): Promise<string>
```

Multimodal parts (AI SDK v6, `ai@^6`):

- **image** → `{ type: 'image', image: base64, mediaType }` (proven in
  `describe-page.ts`).
- **pdf** → `{ type: 'file', data: base64, mediaType: 'application/pdf', filename }`.
- **svg** → no image part; embed the (capped) SVG source as a `text` part. Vision
  endpoints reject `image/svg+xml`; SVG is XML, so describing the source is both
  correct and cheap.

Errors mirror `describe-page.ts` exactly: `ReflectError('auth')` on 401/403,
`ReflectError('network')` on 429/5xx/timeout (caller retries later), and a new
`AssetDescriptionRejectedError` on other 4xx (permanent — logged, no description).
`maxRetries: 0`; the reconcile pass is the retry layer. 60s `AbortSignal.timeout`.

Provider resolution: `defaultAiProvider(state)` (the configured default, else the
first configured provider), key via `getSecret(aiKeySecretName(config.id))` —
identical to capture
([`provider-config.ts`](../../packages/core/src/ai/provider-config.ts),
[`secrets.ts`](../../packages/core/src/ai/secrets.ts)).

### Privacy gate — the crux

`private: true` is a hard block (AGENTS.md). An asset is sendable iff **≥1
non-private note references it and 0 private notes reference it**; unreferenced →
skip.

```ts
type AssetVerdict = 'send' | 'skip-unreferenced' | 'skip-private'

async function classifyAsset(assetPath: string, generation: number): Promise<AssetVerdict>
```

Implementation (reusing the established live-recheck pattern from
[`ai/chat/tools.ts` `isPrivateLive`](../../packages/core/src/ai/chat/tools.ts) and
[`actions/capture.ts` `notePrivate`](../../packages/core/src/actions/capture.ts)):

1. **Candidate set** from the index `assets` join (already populated by the
   indexer — `crates/index-schema/migrations/0001_initial.sql`, surfaced as
   `db.selectFrom('assets')…`): the notes that reference `assetPath`.
2. For each candidate, **read live note markdown** and (a) confirm the live body
   still references the asset (parser/`isAssetHref`), (b) read the live `private`
   flag (`splitFrontmatter` + `parseFrontmatter`). Fail **closed**: an unreadable
   note counts as private.
3. Verdict: any live private referer → `skip-private`; zero live public referers →
   `skip-unreferenced`; else `send`.

The index is used only to find *candidates* cheaply; the privacy decision is made
from **live** markdown. **The index-lag race is closed:** the asset controller no
longer reacts to the raw `index:changed` stream — it drives off the indexer's
**post-apply** signal (`subscribeIndexApplied`, emitted by `subscribeIndexChanges`
*after* a batch's note rows are written, on the same serialized apply queue). So
when the gate runs, the triggering batch's notes — including a just-written
**private** note — are already in the index and its `assets` projection; the gate
can't read a stale snapshot. The encoding half is closed independently: asset
hrefs are decoded at index-write (so an alternate spelling can't hide a referer),
and the Phase 2 `PROJECTION_VERSION` bump rebuilds legacy rows into the decoded
form. The only window that remains is inherent and out of scope per v1: a private
reference added *after* a description was already generated — descriptions are not
retracted in v1 (v2 indexing reapplies the gate).

### Reconcile action — `packages/core/src/actions/asset-description.ts`

Mirrors `reconcileCaptureEnrichment` / `reconcileAudioMemos`:

```ts
export type AssetDescriptionMode = 'incremental' | 'backfill'

export interface ReconcileAssetDescriptionsInput {
  providers: AiProvidersState
  generation: number
  mode: AssetDescriptionMode
  /** incremental: eligible asset paths from the watcher batch. */
  changed?: readonly string[]
  fetchFn?: typeof fetch
  isStale?: () => boolean
  onProgress?: (done: number, total: number) => void
}

export interface ReconcileAssetDescriptionsOutcome {
  pending: number
  described: number
  skippedUpToDate: number
  skippedPrivacy: number
  skippedUserAuthored: number
  refused: number               // permanent refusals (logged, no description)
  stopped: ReconcileStop | null // 'config' | 'auth' | 'network' | 'stale'
}
```

Per-asset loop (each gated by `isStale()`). **The privacy gate runs first** — we
never read or send an asset's bytes until the notes index shows it is associated
with a non-private note (and no private note):

1. Resolve eligibility by extension; classify `kind` (image/pdf/svg).
2. **`classifyAsset` → skip-private / skip-unreferenced (before any asset read).**
   Private and unreferenced assets are never read, hashed, or sent.
3. Read source bytes (`readAsset(path, generation)` → base64); compute
   `sourceHash`/`sourceSize` (`hashContent`).
4. Description decision (managed marker + hash) → skip up-to-date / skip user-authored;
   size cap → skip oversize.
5. `describeAsset(...)`. On `AssetDescriptionRejectedError`: log, `refused++`,
   continue. On `ReflectError('auth'|'network')`: stop the pass (`stopped`) for a
   later retry — nothing written.
6. Write the description (`writeNote(descriptionPath, body, generation)`), `described++`,
   `onProgress`.

**Candidate set:** `incremental` uses `input.changed`; `backfill` enumerates all
eligible files via `listDir('assets', generation)` (the only difference between
modes). The hash/marker idempotency makes both modes safe to re-run.

### Watcher extension — `apps/desktop/src-tauri/src/watcher.rs`

Today `tracked_relpath` reports `.md` under `daily/`/`notes/`, anything under
`audio-memos/`, and `.reflect/inbox/*.json`. **Add** eligible asset files:

```rust
let asset = rel_str.starts_with("assets/")
    && has_eligible_asset_ext(&rel_str)   // png/jpg/jpeg/gif/webp/svg/pdf
    && !rel_str.ends_with(".reflect.md"); // never the descriptions themselves
(note || recording || capture || asset).then_some(rel_str)
```

This follows the existing precedent (audio recordings are tracked but *not*
indexed; "frontend consumers filter by path"). The indexer keeps ignoring
non-note paths; only the asset controller acts on these. Excluding `.reflect.md`
prevents a self-trigger loop (descriptions also live under `assets/`). Update the
module doc comment and the existing `tracked_relpath` unit tests.

### Desktop controller — `apps/desktop/src/lib/asset-describe-controller.ts`

Clone of `createCaptureController`: `disposed` gate → `isStale`, `running`/`queued`
single-flight coalescing, `generation` pin, `providerFetch`, plus a **dirty set**
of asset paths so a transient stop retries exactly those on the next trigger.
Triggers: `subscribeIndexApplied` — the indexer's **post-apply** signal, so the
privacy gate always reads a settled index (closes the index-lag race). From each
applied batch: eligible **asset** upserts mark the asset dirty; **note** upserts
are read + parsed and their referenced eligible assets marked dirty (the "relevant
note changes" trigger, so an asset a note edit newly makes public gets described
even though the asset file didn't change) — plus `focus`/`online` retry of the
dirty set. **No launch backfill** — incremental only processes changed/affected
assets; existing assets wait for the explicit button. Background, best-effort:
stops are logged, never toasted.

A separate exported `backfillAssetDescriptions(generation, onProgress)` runs the
reconcile in `backfill` mode for the Settings button.

### Provider wiring — `apps/desktop/src/providers/asset-describe-provider.tsx`

Clone of `capture-provider.tsx` / `audio-memo-provider.tsx`: mounts the controller
for the active graph generation, gated by the `describeAssets` setting; disposes
on graph switch/unmount. Mounted next to `<CaptureProvider>` / `<AudioMemoProvider>`.

### Settings — `packages/core/src/settings/schema.ts`

```ts
export const describeAssetsSchema = z.boolean().catch(true) // Decision D1
// settingsSchema.looseObject: describeAssets: describeAssetsSchema
```

`describeAssets` controls **auto-describe of new assets** (the event-driven path).
Read/write through `useSettings()`. Note: settings keys ripple into full-doc test
assertions — update those fixtures.

### Settings UI — `apps/desktop/src/components/settings/describe-assets-field.tsx`

Mirrors
[`rebuild-index-field.tsx`](../../apps/desktop/src/components/settings/rebuild-index-field.tsx):
a `SettingsField` with (a) the auto-describe toggle and (b) a "Describe existing
assets" button that runs the backfill with a cost warning and progress.

- Legend: **Describe assets**
- Description (short, action-first per house copy): *"Reflect can describe images
  and PDFs in your assets so their contents are searchable. Descriptions are
  generated by your configured AI provider and may incur charges. Private and
  unreferenced files are skipped."*
- Button: **Describe existing assets** → **Describing…** (spinner) with `done/total`.
- Disabled when no provider is configured or no graph is open.

## Steps (phased; each independently testable)

1. **Core contracts + AI + reconcile (no watcher, no UI).** `describe-asset.ts`,
   the description path/frontmatter/managed-marker helpers, `classifyAsset`,
   `reconcileAssetDescriptions` (both modes). Heavy unit coverage: idempotency,
   managed-vs-user-authored, privacy verdicts (public-only, any-private,
   unreferenced, fail-closed), eligibility/`kind` mapping, error classification,
   `isStale` abort.
2. **Watcher.** Extend `tracked_relpath` + doc comment + Rust unit tests; confirm
   the frontend file-change consumer routes eligible asset upserts and the indexer
   still ignores them.
3. **Controller + provider.** `asset-describe-controller.ts`,
   `asset-describe-provider.tsx`, mount it; controller unit test (single-flight,
   abort-on-dispose, no launch backfill).
4. **Settings.** Schema key + `describe-assets-field.tsx` + wire backfill +
   progress; update settings full-doc fixtures.
5. **Polish + verify.** `pnpm check`, targeted `pnpm test --run`, relevant
   `cargo test`, and a manual run (drop an image into `assets/`, reference it from
   a public note → description appears; reference from a private note → none).

## Acceptance criteria

- Dropping an eligible asset referenced by a public note produces
  `…​.reflect.md` with the correct frontmatter and a description (+ OCR when text
  is present).
- An asset referenced by **any** private note is never sent and gets no description.
- An unreferenced asset is never sent.
- Replacing an asset (new bytes) regenerates the managed description; an unchanged
  asset is skipped; a user-authored `…​.reflect.md` is never overwritten.
- Auth/network failure stops the pass and retries later; permanent refusal is
  logged with no description written.
- No automatic backfill on graph open/provider connect; the Settings button runs
  backfill with a cost warning and progress, and is abortable on graph switch.
- The note index, backlinks, and search are unchanged (no descriptions indexed).

## Risks & open decisions

- **D1 — Auto-describe default. RESOLVED: default on** (new assets only; gated
  public-only; backfill stays manual). The "avoid backfill" concern is about
  *existing* assets, not new ones.
- **D2 — PDF provider capability.** PDF-as-file-part support varies by
  provider/model (Anthropic/Google/OpenAI differ). v1 relies on the refusal path
  (a model that can't take a PDF returns 4xx → logged, no description). *Open: add a
  capability hint to the catalog to skip/relabel known-unsupported combos?*
- **D3 — SVG handling.** Send SVG source as text (vision endpoints reject SVG).
  Acceptable and cheap; rasterization is a possible future improvement.
- **D4 — Size cap.** Cap source bytes (propose 20 MB) and skip oversize assets
  with a logged reason; downscaling images via the Rust `image` crate (as capture
  does) is deferred. *Open: confirm cap + whether to downscale large images.*
- **D5 — Privacy completeness. RESOLVED: index-candidate + live-recheck**
  (fail-closed), with hrefs canonicalized at index-write so encoding variants
  can't hide a referer, **and** the controller sequenced behind the indexer via
  the post-apply `subscribeIndexApplied` signal so the gate always reads a settled
  index (see "the index-lag race is closed" above). The only remaining window —
  a private reference added *after* a description exists — is the v1 no-retraction
  decision, reapplied by v2 indexing.
- **D6 — Refusal re-attempts.** No failure description means a refused asset is
  retried on its next change (incremental) or on every backfill. Acceptable;
  passes are change-triggered, not continuous (no loop).

## Search integration (Phase 2)

> **Status (2026-06-16): Implemented.** Lexical only; transparent surfacing;
> descriptions treated like body text (decisions confirmed). Closes the "v2
> indexing" item deferred above.

**Goal:** a query typed in ⌘K that matches an asset's AI description surfaces the
note(s) that reference that asset, as ordinary hits.

**Design — fold into the note's FTS `body`, search-index-only.**
- `IndexedNote` gains `assetText`. When a note is indexed, `gatherAssetDescriptionText`
  (`indexing/asset-description-text.ts`) reads each referenced asset's
  `…​.reflect.md` body (managed or user-authored — D1), strips frontmatter,
  concatenates, and caps at 8 KB (D2). All three `buildIndexedNote` call sites
  (`indexNote`, `rebuildIndex`, `reconcileIndex`) gather it.
- Rust `apply_note` writes `search_fts.body = note.text + "\n" + asset_text`.
  **`notes.preview`, `note_text`, and AI-reachable text stay the note body
  alone** — so descriptions are locally searchable but never widen the All-Notes
  preview or what is sent to a provider (those read the note body / live
  markdown). That falls out of enriching only the FTS column.
  > **Addendum (PR #630):** AI chat can now read description text explicitly via
  > the `read_assets` tool (`ai/chat/read-assets.ts`), behind its own live
  > privacy verdict. Note text and previews are still never widened.
- `PROJECTION_VERSION` 8 → 9, so existing graphs rebuild and fold descriptions.

**Async re-index seam.** Descriptions are written *after* a note is indexed and
live in `assets/`, so the note's hash is unchanged and nothing re-indexes it on
its own. `reconcileAssetDescriptions` now returns `describedAssetPaths`; after a
pass, both callers (the controller and the Settings backfill) call
`reindexNotesReferencing(paths, generation)` (`indexing/indexer.ts`) — it looks
up referencing notes via the `assets` table and `indexNote`s each (not
hash-gated, so the unchanged files re-index and pick up the new text). No loop:
`indexNote` writes index rows, not note files.

**Privacy.** None added — local lexical search already includes private notes,
and enriching only `search_fts.body` keeps descriptions out of AI/cloud and the
preview. (`descriptionPathFor`/`DESCRIPTION_SUFFIX` moved to `graph/paths.ts` so
`indexing/` need not import `actions/`.)

**Deferred:** ~~semantic embedding of descriptions~~ (shipped later: description
bodies chunk into the referencing note's embedding set, mirroring the FTS fold —
see `embeddings/pipeline.ts`); attributed "matched in image: X" result UI
(transparent chosen — though asset chunks carry the asset filename as their
chunk heading).

## Conventions

Per AGENTS.md: no `any`; zod at boundaries; kebab-case files; one component per
file; providers + hooks for state; small modules; document public APIs;
`pnpm typecheck` + targeted `pnpm test --run` + relevant `cargo test` before done.
