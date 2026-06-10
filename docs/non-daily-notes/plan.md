# Non-daily note editing — plan

Branch: `feat/non-daily-note-editing-20260609-2233` · Base: `master` @ `4fe1dc8`

## Request

> "Currently, we can just edit daily notes. It's important that we can edit
> non-daily notes as well. See the old Reflect repo for inspiration on what I
> mean."

## Audit: what master already does

The kickoff hypothesis ("non-daily note routes may not render, or may fall back
to the daily stream") is **stale**. As of `4fe1dc8`:

- `routing/route.ts` has a typed `{ kind: 'note'; path }` route, and
  `routeForPath()` maps non-daily paths to it (tested in `route.test.ts`).
- `RouteContent` in `components/graph-workspace.tsx` renders
  `<NotePane path={route.path} lazy autoFocus />` for note routes — the same
  editable pane the daily stream mounts per day, with backlinks + related
  notes below.
- Ordinary notes are reachable from every product flow: ⌘K palette rows
  (`command-palette.tsx` → `routeForPath`), backlinks panel, related notes,
  Mod+click on `[[wiki links]]` (incl. create-from-unresolved), the `[[`
  autocomplete create row, `note.new` (⌘N) and `note.random` commands.
- Title-as-first-heading rename tracking (Plan 07b) already works for
  non-daily notes and is well tested (`title-rename.test.ts`,
  `use-note-document.test.tsx`).
- Protected (lossy round-trip) notes open read-only; frontmatter is
  session-owned and never enters the editor.

All 187 desktop tests pass on the base commit.

## The actual gaps

1. **The route→view seam has zero test coverage.** `RouteContent` is a private
   function of `graph-workspace.tsx`; nothing asserts that `{ kind: 'note' }`
   renders an editable editor bound to that file rather than the stream /
   settings / a fallback. This is exactly the acceptance criterion of this
   task, and exactly the regression the request worries about.

2. **⌘N produces forever-untitled notes.** `note.new` navigates to a lazy
   `notes/<ulid>.md`; the editor opens empty with no title affordance. A note
   typed without a leading `# Heading` derives its index title from the
   filename (`deriveTitle` fallback in `packages/core/src/markdown/extract.ts`)
   — i.e. a ULID. Such notes are unfindable garbage rows in ⌘K/recents/
   backlinks. Old Reflect never let this happen: a new note opens with focus
   in the title and shows "Untitled" until named.

## Old Reflect references (product intent)

- `client/models/note/note.ts` (~119, 161–164, 199–225): `daily: prop(false)`
  distinguishes ordinary notes; `subject` (the title) is **derived from the
  document's first heading**; a settled subject change queues
  `requestRewriteIncomingBacklinks()`. Reflect Open mirrors all of this.
- `components/.../NoteEditMain.tsx` (~131): a new note focuses the editor with
  `focusEditor({ selection: 'subject_end' })` — focus lands in the title.
- `client/models/note/note.ts` (~162): empty subject displays as "Untitled".
- `client/core/router-view.ts` (31–36): `NoteEdit` (ordinary) vs `NoteDaily`
  (stream) are separate main screens over the same note model — ordinary notes
  are first-class editable views, not stream rows.

## Chosen seam

**A. Make the route→view mapping a tested unit.** Extract `RouteContent` (and
its private `SearchRoute`) from `graph-workspace.tsx` into
`components/route-content.tsx` (small-files convention), and add integration
tests over the real `NotePane`/session/fake-bridge stack:

- `{ kind: 'note', path: 'notes/foo.md' }` renders an editable
  (contenteditable) editor seeded with the file's content — not the daily
  stream.
- A lossy note (task list) renders the read-only protected view.
- `{ kind: 'daily' }` / `{ kind: 'today' }` render the daily stream;
  `{ kind: 'settings' }` renders settings.
- A missing `notes/*.md` path renders the seeded "Untitled" title (below) and
  creates no file until edited.

**B. Give new ordinary notes a title, old-Reflect style, without breaking the
lazy contract.** When a **missing non-daily** note opens (⌘N's fresh ULID
path, or any dangling note link):

- The session seeds the buffer with `# Untitled\n` and reports
  `missing: true`. The seed is also adopted as the dirty-comparison baseline,
  so *no file is written until the user actually edits* — the lazy "opening
  never litters, writing does" contract is preserved verbatim.
- The pane selects the word "Untitled" on focus (macOS rename pattern; old
  Reflect's `subject_end` focus + "Untitled" placeholder). Typing replaces it,
  so the first keystroke names the note and the first save writes
  `# <Title>\n…` — the indexer then derives a real title.
- The rename tracker baselines on the **real** (empty) disk content, so the
  first authored title is a birth, not a rename — no junk alias, no rewrite.
- Daily notes pass no seed: stream behavior is byte-for-byte unchanged.

Why literal `# Untitled` and not an empty seeded heading + placeholder: an
empty ATX heading is a round-trip trap — meowdown serializes `#\n\nbody` as
`# \n\nbody` (trailing space), which `checkRoundTrip` classifies **lossy**, so
any whitespace-trimming tool would flip such notes read-only. `# Untitled\n`
round-trips exactly (verified against meowdown).

## Out of scope (deliberate)

- Workspace chrome parity (note header bar, sidebar) — a separate UI-parity
  run is active; this branch avoids broad UI changes.
- Plain-click wiki-link navigation (Mod+click is the live-preview convention
  here, documented in `wiki-links.ts`).
- Eager note creation on ⌘N (old Reflect force-saved on create; Reflect Open
  decided lazy-create — we keep that decision).

## Acceptance criteria

1. `{ kind: 'note', path: 'notes/foo.md' }` renders an editable NotePane for
   that file — covered by new `route-content` tests.
2. Daily routes still render the stream; settings still renders settings;
   protected notes stay read-only — same tests.
3. A missing ordinary note opens with a selected "Untitled" title; no file
   exists until the user edits; the first save writes the titled markdown —
   covered by new note-session tests + route-content test.
4. Existing rename-tracking, palette, backlinks, related-notes, wiki-link and
   daily-stream behavior unchanged — full existing suite stays green.

## Verification plan

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (desktop package), `pnpm build`.
- Targeted: `pnpm --filter @reflect/desktop test --run src/components/route-content src/editor/note-session src/editor/title-selection`.
- Browser pass via `pnpm tauri dev` if the local Rust toolchain cooperates;
  otherwise document the blocker (plain `pnpm dev` has no IPC bridge, so file
  IO is unavailable in a bare browser).
