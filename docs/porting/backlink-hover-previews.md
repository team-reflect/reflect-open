# Porting backlink hover previews

**Status: planned.** Reflect v1 showed a compact preview when the pointer
rested on an inline backlink. V2 already has local note resolution, reads, and
read-only markdown rendering, but Meowdown does not yet expose the wiki-link
hover UI needed to join them.

This is separate from both the `[[` autocomplete menu documented in
[Reflect v1: Backlink Menu & Date Generator](../reflect-v1-backlink-menu.md)
and the incoming-backlinks panel delivered by
[Plan 07](../plans/07-backlinks.md). In v1 terminology the inline link itself
was a "backlink"; this document calls it a **wiki link** where that avoids
confusion.

## Legacy reference

The behavior below was verified against:

- the Reflect v1 repository at
  `a7fa07f6792268f5c15dac35297d39f97e22149c`;
- the reflect-editor repository at
  `6456d2293879e01420fd7bea1a712f39057eb8dc` (`0.28.1`, the version used by
  that Reflect snapshot).

### What the user saw

- Hovering a resolved wiki link in either a regular note or a daily note
  opened a read-only preview of the linked note. It was not wired to incoming
  backlink snippets, tags, external links, or static/public views.
- There was no intentional dwell delay. The card appeared after the local
  target-note lookup. Leaving emitted a dismiss event immediately, but the app
  redundantly repeated the async lookup before clearing the card.
- The card followed the pointer, nominally 20px below and to its right. It
  shifted or flipped to remain at least 8px inside the viewport.
- A normal note rendered its entire stored editor document, including its
  title, at extra-small editor typography. The viewport was a fixed
  `350 × 200px`, clipped with no scroll or fade.
- A note backed by v1's ASIN/book store showed a special 300px-wide book card:
  an `80 × 128px` cover, authors, and a truncated title linking to Amazon.
- Missing targets showed nothing. Empty notes could produce an empty card;
  loading and read failures had no explicit state.
- The preview was pointer-only. Wiki links had `tabindex="-1"`, and there was
  no keyboard-focus or touch equivalent.

The same preview component was reused by v1's graph map, which had its own
event source. That reuse is not part of this port because v2 has no graph-map
surface yet.

### How it was wired

| Legacy source | Responsibility |
| --- | --- |
| `reflect-editor/src/types.ts`, `components/reflect-editor.props.ts`, and `extensions/backlink/backlink-hover-plugin.ts` | Exposed `(event, backlink, hovering)`, delegated editor mouse events, recovered the backlink node, and de-duplicated repeated hits. |
| `reflect/client/models/note/note-document-view.ts`, `screens/main/note-edit/note-edit-main.tsx`, and `screens/main/notes-daily/note-item.tsx` | Looked up `backlink.id`, held preview state, and wired the same card into regular/split and daily editors. |
| `reflect/components/pointer-card/pointer-card-anchor.tsx`, `note-preview/note-preview-popover.tsx`, and `ui/popover.tsx` | Followed the pointer with a virtual Radix anchor, handled collisions, portaled the card, and preserved editor focus. |
| `reflect/components/note-preview/popover/note-content.tsx`, `note-book.tsx`, and `utils.ts` | Rendered stored `note.documentHtml` in the clipped static editor or selected the ASIN-specific book card. |

Three historical fixes capture behavior a future implementation can easily
miss:

- `reflect@368869e73` made the preview follow the pointer.
- `reflect@689c3e957` enabled viewport collision avoidance.
- `reflect-editor@8453e8f3` moved hover tracking out of per-node listeners so
  deleting the currently hovered link still emitted leave.

The final feature had no meaningful direct tests. Its app handler also had no
stale-request guard: a slow lookup for A could reopen A after leave or replace
a newer preview for B. It rendered the full stored document despite clipping
it to 200px, so large notes and remote media could be expensive, and pending
edits were not guaranteed to appear. These are legacy hazards, not contracts.

## Porting contract

The product value is a quick glimpse of a linked note without leaving the note
being edited. Preserve that value while adopting v2's boundaries:

| Preserve from v1 | V2 rule |
| --- | --- |
| Regular and daily-note editor coverage | Install the optional feature only on pointer-capable primary note panes; existing click and `Mod-Enter` navigation remain the touch/keyboard paths. |
| The actual note, not a generated summary | Resolve and read locally. Never invoke AI, a Reflect service, or another content-processing service. |
| The same date/title/alias meaning as link navigation | Use a side-effect-free, ambiguity-preserving existing-target resolver. Hover never creates a regular or lazy daily note. |
| A compact, collision-aware overlay | Meowdown owns link hit testing, anchoring, timing, positioning, focus behavior, and the host-content slot. Reflect owns the local content placed in it. |
| Dismissal when the link or editor goes away | Close on leave, link deletion/rewrite, navigation, graph switch, window close, or unmount; stale async work can never reopen it. |
| Generic note content | Do not port the ASIN/book card in the first pass; v2 has no corresponding store. Graph-map reuse waits for a map surface. |

Do not add a mobile long-press as part of this work. A touch preview gesture
would need its own interaction design.

## Recommended v2 shape

The split follows [Editor architecture](../contributing/editor-architecture.md),
[Plan 05](../plans/05-markdown-editor.md), and the porting convention that
editor-level overlay UI belongs upstream in Meowdown.

### 1. Add a Meowdown wiki-link hover component

Meowdown already has the relevant machinery for ordinary Markdown links:

- `packages/core/src/extensions/mark-hover.ts` delegates mark enter/leave;
- `packages/core/src/extensions/link-hover.ts` specializes it for links;
- `packages/react/src/components/link-menu.tsx` derives a stable virtual
  anchor, positions the overlay, and handles delayed open/close.

Add the wiki-link equivalent alongside the existing `onWikilinkClick`
contract. Meowdown should own hit testing, a stable link-range anchor, hover
lifecycle, viewport collision, and focus behavior, while accepting a host
renderer/slot for the target-specific body. Reflect should not attach
listeners to Meowdown's private `.md-wikilink-*` DOM classes or build a second
overlay lifecycle around the event.

The Meowdown layer must emit leave when the hovered mark is deleted or
replaced. That is the regression `reflect-editor@8453e8f3` fixed.

### 2. Supply content from the primary `NotePane`

`apps/desktop/src/editor/note-editor.tsx` is the thin Meowdown wrapper. Thread
the host renderer through it without putting note resolution or loading state
there.

`apps/desktop/src/components/note-pane.tsx` should supply the renderer through
a focused hook/component, just as it supplies `useWikiLinkNavigation`. Keep
the prop optional and pass it only from primary note panes, not compact task
editors. Mobile mounts `NotePane` too, so omit it when
`isTouchEditorSurface()` is true.

### 3. Resolve an existing target without creating it

The current pieces are in `packages/core/src/indexing/queries.ts` and
`packages/core/src/graph/create-note.ts`:

- `findExactWikiTargetMatches` preserves ambiguity within the winning indexed
  date/title/alias tier, but it is internal and index-only;
- `resolveWikiTarget` collapses ambiguity to one deterministic path;
- `resolveOrCreateNoteWithTitle` preserves ambiguity and checks the on-disk
  slug family when the index lags, but can create on a miss.

Extract a public, side-effect-free existing-target resolver from the last
flow. It should share the click path's precedence and stale-index disk check,
return resolved / ambiguous / missing, and stop before creation. Continue to a
preview only for one existing path. Missing daily dates remain valid click
targets but have no file to preview. No index schema migration is required,
and the incoming-backlinks query/panel remain untouched.

### 4. Read and render without content egress

Read the freshest authoritative source: a loaded open session's live buffer,
or `readNote(path, graph.generation)` otherwise. Reuse only the session-first
idea from `apps/desktop/src/lib/note-frontmatter.ts`'s `readNoteSource`; its
fallback converts `notFound` to an empty note and is not generation-pinned,
which is wrong for this feature. Preserve missing/deleted as unavailable and
discard a read that finishes after the graph changes.

Factor the reusable body/loading behavior from
`apps/desktop/src/components/command-palette/note-preview.tsx`: strip
frontmatter and render the body with
`apps/desktop/src/editor/markdown-preview.tsx`. A daily note needs the same
separate formatted-date heading the command-palette preview adds because its
markdown body does not contain the date as an H1.

The first port should be passive and local-only:

- wiki links and ordinary Markdown links inside the card are inert;
- preview images resolve safe graph assets only;
- remote images, embeds, and other automatic network loads are disabled.

`MarkdownPreview` currently always wires ordinary external links, and
`useAssetPersistence.resolveImageUrl` passes through `http(s)` sources, so the
shared renderer needs explicit non-interactive and local-media-only options
rather than relying on omitted wiki-link callbacks. With those constraints, a
`private: true` note can be previewed locally like any other note without
changing the guarantees in [Privacy](../privacy.md).

## Correctness and test checklist

- Meowdown emits one enter for a wiki link, ignores movement among its child
  elements, leaves before entering an adjacent link, and closes when the
  hovered mark is deleted or replaced.
- The overlay remains inside every viewport edge and opening/closing it does
  not change editor focus, selection, or undo history.
- A uniquely resolved indexed title, alias, or existing daily date previews
  in both regular and daily editors. Templates, missing targets, and ambiguous
  targets never show an arbitrary note.
- The side-effect-free resolver covers an index-lagging on-disk match and
  proves that every missing-target path performs no write or create.
- Enter A then B, or enter then leave, stays correct when async results resolve
  out of order. Navigation, graph change, unmount, and target deletion discard
  pending results and stale bodies.
- Frontmatter is hidden, daily dates remain visible as headings, and empty,
  missing, and read-error states never flash the previous note.
- Preview rendering cannot activate any link or load remote media, including
  for `private: true` notes.
- Only pointer-capable primary note panes receive the hover renderer. Task
  editors and touch-only surfaces do not.
- Existing click and `Mod-Enter` navigation behave unchanged.
- Large-note coverage measures the cost of parsing the full clipped preview;
  optimize later with a markdown-aware preview projection if needed, never by
  cutting raw markdown mid-token.

## UX decisions to make before implementation

- **Timing:** v1 opened immediately; Meowdown's Markdown-link menu currently
  uses a 400ms open delay and 300ms close grace. Choose deliberately and test
  rapid pointer travel.
- **Interactivity:** the v1 book markup contained a real external anchor, but
  leaving the source link initiated dismissal with no close grace. Decide
  whether a later v2 card can be entered or scrolled; keep the first port
  passive.
- **Viewport:** v1 clipped at `350 × 200px`. Preserve that compact baseline or
  choose a tokenized max size and fade.
- **Unavailable state:** decide whether missing, ambiguous, empty, and failed
  targets show nothing or a small explicit state. None may trigger creation.
