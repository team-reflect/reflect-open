# Plan 20 — Asset Descriptions

> **Status (2026-06-16): Implemented.** Built end-to-end against the contracts below:
> the AI call (`packages/core/src/ai/asset-describer-service.ts`), the reconcile,
> session loop, and backfill (`packages/core/src/assets/asset-description-service.ts`),
> the privacy gate (`packages/core/src/assets/asset-privacy-service.ts`,
> `packages/core/src/indexing/asset-refs.ts`), the watcher carve-out
> (`apps/desktop/src-tauri/src/watcher.rs`), and the Settings control
> (`describeAssets` setting +
> `apps/desktop/src/components/settings/describe-assets-field.tsx`). Decisions D1
> (auto-describe **on** for new assets) and D5 (index-candidate + live recheck) landed
> as recommended. A post-release add-on in the spirit of [Plan 18](18-tasks.md): an
> opt-in enrichment layer on the shipped storage/index/AI spine.

**Goal:** Give every eligible image and PDF under `assets/` a local Markdown
**description file** with an AI summary plus any OCR/extracted text, so asset contents
become portable, greppable, and ready for search, **without** changing the note index
and **without** ever sending a private or unreferenced asset to a provider.

**Depends on:** Plan 02 (`assets/`), Plan 03 (frontmatter model), Plan 04 (watcher +
index), Plan 10 (BYOK providers, keychain, `private: true`). Reuses the Plan 11 capture
enrichment machinery almost verbatim.

**Unlocks:** asset search (Phase 2 below). Phase 1 only *produces* descriptions.

**Architecture:** all policy (eligibility, privacy, AI calls, writes) lives in
`@reflect/core`; the desktop owns the watcher trigger, the single-flight controller, and
Settings, mirroring capture and audio memos.

## Scope

**In:**

- `png`, `jpg`/`jpeg`, `gif`, `webp`, `svg`, `pdf` under `assets/`.
- Description path appends `.reflect.md` (`assets/diagram.png` →
  `assets/diagram.png.reflect.md`).
- Managed frontmatter (source path, hash, size, provider, model, timestamp) + a managed
  marker. Rewrite only when the source hash changes; **never** overwrite a user-authored
  file at that path.
- One multimodal BYOK call returning a concise description plus extracted text.
- Privacy gate on live note Markdown: process an asset **only** if ≥1 non-private note
  and **0** private notes reference it. Skip unreferenced assets.
- Event-driven processing of eligible asset changes (and relevant note changes),
  single-flight, generation-pinned, abortable on graph switch.
- Manual backfill ("Describe existing assets") with a cost warning and progress.

**Out (v1):**

- **No automatic backfill** on graph open or provider connection: existing graphs may
  hold many large, costly assets.
- **No description retraction.** If an asset later becomes private/ambiguous, its
  description stays. Indexing must reapply the privacy gate at *index* time.
- **No new index tables.** Descriptions live under `assets/` (not indexed).
- **No failure descriptions.** Permanent refusals are logged only; auth/network errors
  stop the pass for a later retry.
- Video/audio (audio has its own memo path); downscaling/transcoding (cap-and-skip).

## Why this shape

Reflect V1 called a Reflect-hosted image-description API; V2 must not (no hosted APIs).
Capture already inverted this correctly: the desktop makes BYOK calls, gates `private`,
and writes locally. This plan reuses that spine. The one new surface is the
**description file**: a portable, inspectable Markdown artifact beside the asset that
travels with the graph folder (the portability contract).

## Contracts

### Description file

```markdown
---
reflectAsset: true
source: assets/diagram.png
sourceHash: 9f2c…
sourceSize: 18432
provider: anthropic
model: claude-opus-4-8
generatedAt: 2026-06-16T12:34:56.000Z
---

A flow diagram showing the capture pipeline.

## Extracted text

Capture → Inbox → Drain → Enrich
```

**`reflectAsset: true` is the managed marker:** absent file → generate; marked file →
regenerate iff the source hash changed; unmarked file → **user-authored**, never read for
decisions, overwritten, or deleted. "Extracted text" appears only when the model returns
some.

### AI call

A near-clone of the capture page describer with the same error contract. Images go as
image parts, PDFs as file parts. **SVG goes as text:** vision endpoints reject
`image/svg+xml`, and since SVG is XML, describing the source is correct and cheap. Errors:
`auth` on 401/403, `network` on 429/5xx/timeout (retry later), and a distinct
**permanent rejection** on other 4xx (logged, no description). No SDK retries; the
reconcile pass is the retry layer. Provider resolution is the same as capture (default
provider, keychain key).

### Privacy gate (the crux)

`private: true` is a hard block. An asset is sendable iff **≥1 non-private note
references it and 0 private notes do**; unreferenced → skip.

1. The index `assets` join gives the **candidate** referring notes cheaply.
2. For each candidate, read **live** Markdown: confirm it still references the asset and
   read its live `private` flag. **Fail closed:** an unreadable note counts as private.
3. Any live private referer → skip-private; no live public referer → skip-unreferenced;
   else send.

**The index-lag race is closed:** the controller does not react to the raw
`index:changed` stream but to the indexer's **post-apply** signal, emitted on the same
serialized queue after a batch's rows are written. So a just-written private note is
already in the `assets` projection when the gate runs. The encoding half is closed
separately: hrefs are decoded at index-write (so an alternate spelling cannot hide a
referer), and a `PROJECTION_VERSION` bump rebuilt legacy rows. The only remaining window
is inherent: a private reference added *after* a description exists (no retraction in
v1).

### Reconcile

Two modes: `incremental` (changed paths from the watcher) and `backfill` (all eligible
files); the candidate set is the only difference, and hash/marker idempotency makes both
safe to re-run. Per asset, **the privacy gate runs first**: a private or unreferenced
asset is never read, hashed, or sent. Then read + hash, skip up-to-date / user-authored /
oversize, call the AI, write. A permanent refusal counts and continues; auth/network stops
the pass with nothing written.

### Watcher

The watcher also reports eligible files under `assets/`, **excluding `.reflect.md`** to
prevent a self-trigger loop (descriptions live under `assets/` too). This follows the
audio precedent: tracked but not indexed; consumers filter by path.

### Desktop controller

Cloned from the capture controller: single-flight with queued coalescing, generation pin,
and a **dirty set** so a transient stop retries exactly those assets next time. Triggered
by the post-apply signal: asset upserts mark the asset dirty, and **note upserts mark
their referenced assets dirty**, so an asset that a note edit newly makes public gets
described even though the file did not change. Focus/online retry the dirty set. **No
launch backfill.** Background and best-effort: stops are logged, never toasted.

### Settings

`describeAssets` (default **on**, D1) controls auto-describe of new assets. The Settings
field holds the toggle and the "Describe existing assets" button (cost warning, progress
`done/total`), disabled with no provider or no graph. Copy: *"Reflect can describe images
and PDFs in your assets so their contents are searchable. Descriptions are generated by
your configured AI provider and may incur charges. Private and unreferenced files are
skipped."*

## Steps (phased; each independently testable)

1. **Core:** AI call, description helpers, privacy gate, reconcile (both modes). Heavy
   unit coverage: idempotency, managed vs user-authored, privacy verdicts (public-only,
   any-private, unreferenced, fail-closed), eligibility, error classes, stale abort.
2. **Watcher:** asset carve-out + Rust tests; the indexer still ignores assets.
3. **Controller + mount:** single-flight, abort-on-dispose, no launch backfill.
4. **Settings:** key + field + backfill progress; update settings full-doc fixtures.
5. **Verify manually:** an image referenced by a public note gets a description; one
   referenced by a private note gets none.

## Acceptance criteria

- An eligible asset referenced by a public note gets `….reflect.md` with correct
  frontmatter and a description (+ extracted text when present).
- An asset referenced by **any** private note, or by none, is never sent.
- New bytes regenerate a managed description; unchanged assets skip; user-authored files
  are never overwritten.
- Auth/network failure stops and retries later; permanent refusal writes nothing.
- No automatic backfill; the Settings backfill warns about cost, shows progress, and
  aborts on graph switch.
- Phase 1 leaves the note index, backlinks, and search unchanged.

## Risks & open decisions

- **D1, auto-describe default. RESOLVED: on** (new assets only, public-only; backfill
  stays manual). The backfill concern is about *existing* assets, not new ones.
- **D2, PDF capability** varies by provider/model. v1 relies on the refusal path. *Open:
  a catalog capability hint to skip known-unsupported combos?*
- **D3, SVG as text.** Cheap and acceptable; rasterization is a possible future step.
- **D4, size cap** (proposed 20 MB, skip oversize with a logged reason); image
  downscaling deferred. *Open: confirm the cap and whether to downscale.*
- **D5, privacy completeness. RESOLVED:** index candidates + live recheck (fail closed),
  hrefs canonicalized at index-write, controller sequenced behind the post-apply signal.
  The only window left is the no-retraction decision.
- **D6, refusal re-attempts.** With no failure description, a refused asset is retried
  on its next change or every backfill. Acceptable: passes are change-triggered, not a
  loop.

## Search integration (Phase 2)

> **Status (2026-06-16): Implemented.** Lexical only; transparent surfacing; descriptions
> treated like body text.

**Goal:** a ⌘K query matching an asset's description surfaces the notes that reference
the asset, as ordinary hits.

**Design: fold into the note's FTS `body`, search-index-only.** When a note is indexed,
each referenced asset's description body (managed or user-authored, frontmatter
stripped) is concatenated and capped at 8 KB
(`packages/core/src/indexing/asset-description-text.ts`), then appended to the FTS body
only. **`notes.preview`, `note_text`, and AI-reachable text stay the note body alone**,
so descriptions are locally searchable but never widen the All-Notes preview or what
goes to a provider. A `PROJECTION_VERSION` bump rebuilt existing graphs.

> **Addendum (PR #630):** AI chat can now read description text explicitly via the
> `read_assets` tool (`packages/core/src/ai/chat/read-assets.ts`), behind its own live
> privacy verdict. Note text and previews are still never widened.

**Async re-index seam.** Descriptions are written *after* the note is indexed, and the
note's hash does not change, so nothing re-indexes it on its own. After a pass, the
controller and backfill re-index the notes that reference the described assets (not
hash-gated). No loop: indexing writes index rows, not note files.

**Privacy:** nothing added. Local lexical search already includes private notes, and
enriching only the FTS column keeps descriptions out of AI and previews.

**Deferred:** ~~semantic embedding of descriptions~~ (shipped later: description bodies
chunk into the referencing note's embedding set, mirroring the FTS fold; see
`packages/core/src/embeddings/embedding-index-service.ts`); an attributed "matched in
image: X" result UI (transparent was chosen, though asset chunks carry the asset filename
as their chunk heading).
