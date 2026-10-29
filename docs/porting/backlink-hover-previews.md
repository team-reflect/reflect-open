# Porting backlink hover previews

**Status: ported.** Resting the pointer on a wiki link in a primary desktop
note pane opens a compact, passive preview of the existing local target.
Meowdown owns the hover lifecycle and overlay; Reflect owns side-effect-free
resolution, generation-pinned reads, and local-only content.

This is separate from the `[[` autocomplete menu
([Reflect v1: Backlink Menu & Date Generator](../reflect-v1-backlink-menu.md))
and the incoming-backlinks panel ([Plan 07](../plans/07-backlinks.md)). v1
called the inline link a "backlink"; this doc says **wiki link** where that
avoids confusion.

## Legacy reference

Verified against Reflect v1 at `a7fa07f6792268f5c15dac35297d39f97e22149c`
and reflect-editor at `6456d2293879e01420fd7bea1a712f39057eb8dc` (`0.28.1`,
the version that snapshot used).

### What the user saw

- Hovering a resolved wiki link in a regular or daily note opened a
  read-only preview of the target. Not wired to backlink snippets, tags,
  external links, or static/public views.
- No dwell delay: the card appeared after the local lookup. Leave dismissed
  at once (the app redundantly repeated the lookup before clearing).
- The card followed the pointer, nominally 20px below-right, shifting or
  flipping to stay 8px inside the viewport.
- A normal note rendered its whole stored document, title included, at
  extra-small typography in a fixed `350 × 200px` viewport, clipped with no
  scroll or fade.
- ASIN/book notes showed a 300px book card: `80 × 128px` cover, authors,
  and a truncated title linking to Amazon.
- Missing targets showed nothing; empty notes could show an empty card; no
  loading or error state.
- Pointer-only: wiki links had `tabindex="-1"`, with no keyboard or touch
  equivalent.

v1's graph map reused the component; that is not ported because v2 has no
graph map yet.

### How it was wired

| Legacy source | Responsibility |
| --- | --- |
| `reflect-editor/src/types.ts`, `components/reflect-editor.props.ts`, and `extensions/backlink/backlink-hover-plugin.ts` | Exposed `(event, backlink, hovering)`, delegated editor mouse events, recovered the backlink node, and de-duplicated repeated hits. |
| `reflect/client/models/note/note-document-view.ts`, `screens/main/note-edit/note-edit-main.tsx`, and `screens/main/notes-daily/note-item.tsx` | Looked up `backlink.id`, held preview state, and wired the same card into regular/split and daily editors. |
| `reflect/components/pointer-card/pointer-card-anchor.tsx`, `note-preview/note-preview-popover.tsx`, and `ui/popover.tsx` | Followed the pointer with a virtual Radix anchor, handled collisions, portaled the card, and preserved editor focus. |
| `reflect/components/note-preview/popover/note-content.tsx`, `note-book.tsx`, and `utils.ts` | Rendered stored `note.documentHtml` in the clipped static editor or selected the ASIN-specific book card. |

Historical fixes worth not losing:

- `reflect@368869e73`: the preview follows the pointer.
- `reflect@689c3e957`: viewport collision avoidance.
- `reflect-editor@8453e8f3`: hover tracking moved out of per-node
  listeners, so deleting the hovered link still emits leave.

Legacy hazards, not contracts: no meaningful tests; no stale-request guard
(a slow lookup for A could reopen A after leave or replace B's preview);
the full stored document rendered despite 200px clipping, so large notes
and remote media were expensive; pending edits might not appear.

## Porting contract

The value is a quick glimpse of a linked note without leaving the current
one.

| Preserve from v1 | V2 rule |
| --- | --- |
| Regular and daily-note editor coverage | Install the optional feature only on pointer-capable primary note panes; existing click and `Mod-Enter` navigation remain the touch/keyboard paths. |
| The actual note, not a generated summary | Resolve and read locally. Never invoke AI, a Reflect service, or another content-processing service. |
| The same date/title/alias meaning as link navigation | Use a side-effect-free, ambiguity-preserving existing-target resolver. Hover never creates a regular or lazy daily note. |
| A compact, collision-aware overlay | Meowdown owns link hit testing, anchoring, timing, positioning, focus behavior, and the host-content slot. Reflect owns the local content placed in it. |
| Dismissal when the link or editor goes away | Close on leave, link deletion/rewrite, navigation, graph switch, window close, or unmount; stale async work can never reopen it. |
| Generic note content | Do not port the ASIN/book card in the first pass; v2 has no corresponding store. Graph-map reuse waits for a map surface. |

No mobile long-press: a touch preview needs its own interaction design.

## Implemented v2 shape

The split follows [Editor architecture](../contributing/editor-architecture.md),
[Plan 05](../plans/05-markdown-editor.md), and the convention that
editor-level overlays belong upstream in Meowdown.

### 1. Add a Meowdown wiki-link hover component

Meowdown already had this for ordinary links (`mark-hover.ts`,
`link-hover.ts`, `link-menu.tsx`). The wiki-link equivalent sits beside
`onWikilinkClick`: Meowdown owns hit testing, a stable link-range anchor,
hover lifecycle, collision, and focus, and accepts a host renderer for the
body. Reflect must not listen on Meowdown's private `.md-wikilink-*`
classes or build a second overlay lifecycle. Meowdown must emit leave when
the hovered mark is deleted or replaced (the `reflect-editor@8453e8f3`
regression).

### 2. Supply content from the primary `NotePane`

`apps/desktop/src/editor/note-editor.tsx` only threads the renderer through;
no resolution or loading state there. `apps/desktop/src/components/note-pane.tsx`
supplies it through a focused hook, like `useWikiLinkNavigation`. The prop
is optional and passed only from primary note panes, not task editors, and
omitted when `platform.surface.touchEditor` is true (mobile mounts
`NotePane` too).

### 3. Resolve an existing target without creating it

In `packages/core/src/indexing/wiki-resolver-service.ts` and
`packages/core/src/graph/note-creation-service.ts`,
`findExactWikiTargetMatches` is internal and index-only,
`resolveWikiTarget` collapses ambiguity, and `resolveOrCreateNoteWithTitle`
checks the on-disk slug family but creates on a miss. So a public,
side-effect-free resolver was extracted from the last one: same precedence
and stale-index disk check as the click path, returns resolved / ambiguous
/ missing, never creates. Only one existing path previews. Missing daily
dates stay valid click targets but have no file to preview. No index
migration; the incoming-backlinks query/panel are untouched.

### 4. Read and render without content egress

Read a loaded session's live buffer, else `noteFile.read(path,
graph.generation)`. Only the session-first idea comes from
`NoteDocumentService.readSource`
(`packages/core/src/documents/note-document-service.ts`): its fallback turns
`notFound` into an empty note and is not generation-pinned, which is wrong
here. Missing/deleted stays unavailable; a read that finishes after a graph
change is discarded.

The body reuses `apps/desktop/src/components/command-palette/note-preview.tsx`
behavior: strip frontmatter, render with
`apps/desktop/src/editor/markdown-preview.tsx`, and add the formatted-date
heading for daily notes (their body has no date H1).

The card is passive and local-only: links inside are inert, images resolve
safe graph assets only, and remote images and embeds never load.
`MarkdownPreview` wires external links by default and
`useAssetPersistence.resolveImageUrl` passes `http(s)` through, so the
renderer needs explicit non-interactive and local-media-only options. With
those, a `private: true` note previews locally without changing
[Privacy](../privacy.md).

## Correctness and test checklist

- Meowdown emits one enter per wiki link, ignores movement among child
  elements, leaves before entering an adjacent link, and closes when the
  hovered mark is deleted or replaced.
- The overlay stays inside every viewport edge; opening/closing does not
  change editor focus, selection, or undo history.
- A unique indexed title, alias, or existing daily date previews in regular
  and daily editors. Templates, missing, and ambiguous targets never show
  an arbitrary note.
- The resolver covers an index-lagging on-disk match, and no missing-target
  path writes or creates.
- Out-of-order async results (A then B, enter then leave) stay correct.
  Navigation, graph change, unmount, and target deletion discard pending
  results and stale bodies.
- Frontmatter is hidden, daily dates show as headings, and empty, missing,
  and error states never flash the previous note.
- The preview cannot activate a link or load remote media, including for
  `private: true` notes.
- Only pointer-capable primary note panes get the renderer.
- Click and `Mod-Enter` navigation are unchanged.
- Measure the cost of parsing large notes; optimize later with a
  markdown-aware preview projection, never by cutting raw markdown
  mid-token.

## Implementation decisions

- **Timing:** a target-aware 300ms dwell avoids flashes while the pointer
  crosses prose. The card opens once both the dwell and the local read
  finish. Moving to another wiki link switches without a new dwell and
  keeps the previous body until the next is ready; leaving closes after a
  200ms grace.
- **Interactivity:** the card is pointer-transparent and inert. Links,
  checkboxes, images, and embeds cannot navigate, mutate, take focus, or
  load remotely.
- **Viewport:** Meowdown owns the card chrome and clipped surface
  (`320 × 192px`, 8px collision margin); Reflect renders only the content.
- **Unavailable state:** missing, ambiguous, unavailable, deleted, and
  failed targets resolve to nothing, so no card opens. A read note with an
  empty body shows `Empty note`; daily notes keep their date heading.
- **Freshness:** the body is a snapshot from hover start. Deleting or
  rewriting the hovered link closes the card through Meowdown's
  transaction-aware tracking; external file changes while a card is open
  are not tracked.
- **Resolution:** the resolver also has an `unavailable` outcome, so hover
  or navigation never treats a placeholder or transient read failure as
  permission to create a duplicate note.
