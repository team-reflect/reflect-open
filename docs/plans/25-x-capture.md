# Plan 25: X capture

**Goal:** save useful, editable snapshots of X posts into the capture-day Daily,
including when the desktop app is closed or the network is unavailable.

**Depends on:** Plan 11's extension queue, native inbox and background enrichment;
Plan 02's no-clobber note creation; Plan 03's frontmatter and Markdown model.

**Status:** implemented in this branch for draft review. Public, logged-out X DOM
was inspected during development. Authenticated bookmark/like actions and extension
update behavior on already-open tabs still need a browser acceptance pass.

## Product contract

| Action | Result |
| --- | --- |
| Manual Save on a post | A new snapshot for each capture UUID, with its own note, selection and screenshot |
| Opt-in bookmark or like | The first automatic snapshot of that post on that local day |
| Another tab, another automatic action, or unbookmark then bookmark | Reuse that day's existing automatic snapshot without rewriting it |
| A new action on another day | A new automatic snapshot |
| Open a page with previously selected controls | Establish a baseline, without importing historical activity |
| Retry the same queued envelope | Complete its original save, without creating another note or Daily link |
| Edit a pending note or make it private | Stop enrichment and preserve the user's body |
| Recapture a completed note | Leave its body, frontmatter and local media alone |

Automatic capture is off by default. Bookmarks are the primary option; likes are an
additional opt-in. These capture actions, rather than synchronize a collection:
unbookmarking never deletes a note. Deleting or renaming an automatic capture file
allows a later action to create another snapshot; there is no hidden tombstone.

The supported snapshot contains author, plain text, one quoted post, up to four
images or video previews, and a link to the original. Video files, thread assembly,
engagement metrics, AI summaries and repeated annotation merges are out of scope.
Explicit ordinary-page text capture continues to use the existing webpage flow.

## Data flow

```text
X DOM -> bounded XPost -> extension queue -> native inbox
                                             |
                                             v
                                  create raw Markdown note
                                             |
                                     enrich once if owned
                                             |
                                  ordinary user-owned note
```

The extension reads DOM and delivers an envelope. TypeScript core decides identity,
privacy, text selection and completion. Rust provides bounded network and filesystem
capabilities. No new database, scheduler, persistent seen table or delivery ledger
is introduced.

### Wire contract

Ordinary link and text captures remain version 1. X captures use version 2 with a
required `x` field:

```ts
interface XCapture {
  trigger: 'manual' | 'bookmark' | 'like'
  day: string
  post: {
    id: string
    author?: { name: string; handle: string }
    text?: { value: string; complete: boolean }
    images?: Array<{ url: string; alt?: string }>
    quote?: {
      id: string
      author?: { name: string; handle: string }
      text?: { value: string; complete: boolean }
    }
  }
}
```

The actual types are inferred from `capture-envelope.ts` schemas. Post IDs remain
decimal strings. `day` is frozen in the producer's local timezone at capture time,
so retries do not move a note across days after a timezone change. Permalinks are
normalized to `https://x.com/i/status/<id>` and checked against the snapshot ID.

Snapshots are bounded at ingress: 20,000 UTF-16 units of post text, 5,000 of quote
text, four images, and a final 64 KiB UTF-8 envelope limit. Screenshot bytes are
separate; the envelope limit includes the host-stamped screenshot reference.
Automatic captures cannot carry annotations, selections or screenshots. Redundant
page text and recursive quotes are rejected in v2.

Versioning is necessary because old hosts discard unknown JSON fields when they
serialize the envelope. An old host must reject v2 rather than acknowledge a save
that lost its snapshot. The extension recognizes the old host's exact unsupported
version response as an upgrade hold, retains that capture and continues sending
ordinary v1 captures. Popup/options show the upgrade requirement. Other malformed
payloads remain permanent failures.

The existing queue retains at most 50 captures and drops the oldest at capacity.
This feature does not promise unlimited offline collection. A future no-drop queue
policy must cover both manual and automatic producers.

## Files and responsibility

```text
packages/core/src/actions/
  capture-envelope.ts          wire schema, v1/v2 boundary
  capture-identity.ts          capture note/date references
  capture-drain.ts             existing inbox dispatcher
  capture-enrichment.ts        existing scheduler and ownership checks
  capture-enrichment-write.ts  recoverable note/Daily write
  x-post.ts                    lightweight ID/URL helpers and input limits
  x-capture.ts                 first creation, replay and pending input
  x-post-note.ts               one-way Markdown renderer
  x-syndication.ts             external JSON adapter
  x-enrichment.ts              text selection, media and final rendering

apps/extension/
  entrypoints/x-capture.content.ts  injection and cleanup
  entrypoints/options/             settings and permission gesture
  lib/x-page.ts                    DOM extraction and action observation
  lib/x-config.ts                  settings defaults and host patterns
  lib/x-capture.ts                 background admission and lifecycle

apps/native-host/src/envelope.rs   wire validation and snapshot preservation
apps/desktop/src-tauri/src/capture.rs
                                  bounded JSON/image capabilities
```

The existing capture message builder, queue, native transport, popup and manual
snapshot path are extended in place. The watcher imports only lightweight runtime
helpers and erased schema types; it does not load Defuddle, Zod or the core barrel.

## Storage and recovery

Automatic identity is `capture-x-<day>-<post-id>`. Manual identity is
`capture-x-<day>-manual-<full-uuid>`. Both live under `notes/`. Screenshots and images
use the creating envelope's full UUID rather than a shared automatic filename.

`createNoteIfAbsent` performs the no-clobber creation. A collision is only a saved
capture if its metadata matches the intended identity. An unrelated same-name file
is an actionable conflict. Replays use the winner's current title, repair the Daily
link by target, then remove screenshot spool and finally envelope JSON. If any
step fails, the envelope remains available to finish the save.

The ordinary link dedupe path excludes X notes. It must not rewrite a new X snapshot
when an old producer later sends a URL-only capture.

A pending note has three additional metadata fields:

```yaml
captureKind: x
captureId: 7c9e6679-7425-40de-944b-e07fc1f90ae7
captureInput:
  version: 1
  post:
    id: '1234567890123456789'
    text:
      value: Captured text
      complete: false
```

`captureInput` includes the post plus any manual note, selection and promoted
screenshot needed to render the body again after restart. Existing status, hash and
retitle metadata are reused. Input is temporary recovery data, removed together
with terminal completion or relinquishment of ownership. It is not another archive.
Malformed input does not fall through into ordinary link AI enrichment.

The body is output only. Headings such as `## Note` never identify machine-owned
regions, and user Markdown may contain those same headings. External post text and
selection are escaped as plain text; user annotation remains Markdown. Remote media
is rendered as an ordinary source link. Only saved local assets become image embeds,
so displaying an initial private note does not itself fetch remote images.

## Enrichment and privacy

DOM and syndication JSON normalize into the same post shape. Complete text wins over
known incomplete text. Otherwise the longer text wins, with DOM winning ties. This
is a bounded fallback heuristic, not a claim that length proves completeness. Blank
strings are absent. Quote fields are only combined for the same quoted ID.

The syndication token and Unicode range handling follow the public
[react-tweet adapter](https://github.com/vercel/react-tweet/blob/main/packages/react-tweet/src/api/fetch-tweet.ts)
and its [text normalization](https://github.com/vercel/react-tweet/blob/main/packages/react-tweet/src/utils.ts).
The syndication endpoint is an optional, unstable external dependency. An unavailable
post or unsupported response finishes with the captured DOM content. Transient
network/rate-limit/server failures keep the useful raw note pending for retry.

Images use the existing public-host/DNS and redirect guards, a 10 MiB response cap,
8192-pixel decoder limits, a 128 MiB decode allocation limit and 1600-pixel JPEG
output. A missing or unsupported image remains a source link. Network and local
write failures stay retryable; a catch around downloading must not swallow an
asset write failure.

There is no per-image checkpoint. Up to four downloads may repeat after a failed
attempt, using deterministic asset paths. After downloads, the renderer submits
one body update. Finished notes are never enriched again.

Checks before and after slow operations verify the current graph generation,
private flags on the capture and Daily, unchanged body hash/input and clean editor
buffers. The desktop injects dirty checks; core does not import editor sessions.
Dirty buffers defer work without a competing metadata write. Creating a note also
waits for a dirty Daily to settle before copying its privacy flag.

The existing prepared retitle transaction remains necessary: note and Daily are
two files. A prepared note retains input until Daily retitle and final status finish.
Writer checks use their current stage's hash, not the earlier pre-enrichment hash.

These are observable ownership checks, not filesystem compare-and-swap. `writeNote`
atomically replaces a file but cannot exclude an external edit between the final
read and replacement. Coordinating every writer is a separate storage-layer change.
A privacy change stops subsequent requests/results; an already-started request
cannot be undone.

## Extension lifecycle

The content script records an action only after a user activation and a positive
selected-state transition. It does not scan selected buttons and call them new
captures. It retains the envelope UUID while retrying delivery until background
acknowledges durable enqueue. Baselines are page-local, not persistent delivery state.

DOM extraction accounts for nested quoted articles and preserves paragraph breaks.
Both known test-ID controls and the observed public ARIA controls are supported.
Current public markup used `article`, `aria-label`, `aria-pressed` and text containers
with preserved whitespace. This observation does not validate authenticated actions.

Permission requests run directly in the options interaction handler. Background
serializes configuration and automatic admission, owns registration, and handles
startup/update/permission removal. Registering future scripts and injecting already
open tabs are distinct steps. Disable first stops accepting new captures, then
unregisters and signals existing scripts to stop. Repeated injection cleans up the
previous instance. Manual Save uses `activeTab` without enabling ongoing observation.

## Acceptance and validation

Keep tests at behavior boundaries:

- Shared TS/Rust fixtures reject invalid versions, IDs and payload combinations and
  prove that accepted snapshots survive host serialization, including Unicode limits.
- Faults after note creation, Daily write and spool cleanup recover without duplicate
  notes or links. Two manual UUIDs remain independent; same-day auto captures converge.
- Arbitrary user headings, edits, custom/private metadata, dirty buffers and privacy
  changes during failed image fetches retain user data and stop subsequent requests.
- Complete DOM text is not shortened by truncated remote text. Missing content, network
  failure and disk failure have different outcomes. Completed local media stays local.
- Reduced DOM fixtures cover quote isolation, line breaks, positive action detection
  and cleanup. They must not be described as authenticated X acceptance tests.
- Inspect the actual WXT build's manifest, script bundle and dependency composition.
  A source import regex is not evidence of bundle size or transitive dependencies.

Do not add inverse-renderer, persistent-seen or helper-mirroring tests. Useful mutation
checks remove no-clobber creation or a privacy gate, widen the fetch catch to include
asset writes, or reverse complete-text preference; the corresponding behavior tests
should fail.

Before leaving draft, verify logged-in mouse/keyboard bookmark and like, multiple
post views, long-post expansion, permission revoke, repeated injection, and extension
update with an already-open X tab. CI validation and remaining browser checks belong
in the PR's current validation report rather than being inferred from this design.
