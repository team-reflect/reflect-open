# Non-daily note editing — status

Date: 2026-06-09
Branch: `feat/non-daily-note-editing-20260609-2233` (base: `origin/master` @ `4fe1dc8`)

## State: implementation + tests complete, verification green

### Audit result (the starting hypothesis was stale)

The parent-session claim "only daily notes are editable" did not hold against
this base: `note` routes already render a fully editable `NotePane` (lazy
save pipeline, conflicts, protection), reachable via ⌘K palette, wiki links,
backlinks, related notes, ⌘N, and the random-note command. All 187 baseline
tests passed unmodified.

The real gaps, confirmed by audit and fixed here:

1. **The route → view seam was untested and untestable.** `RouteContent`
   lived as a private function inside `graph-workspace.tsx`; nothing pinned
   the contract that a `note` route opens an editable pane rather than the
   stream.
2. **⌘N produced unfindable notes.** A missing `notes/<ulid>.md` opened as a
   blank editor; saving without a heading left a note whose title fell back
   to its ULID filename (`deriveTitle`) — junk in search/palette. Old
   Reflect's new-note flow seeds a subject and focuses it
   (`focusEditor({ selection: 'subject_end' })`).

### Done

- `note-session.ts`: `missing` snapshot flag + `missingSeed` option. The seed
  is adopted as the clean disk baseline (no write until a real edit — the
  lazy no-litter contract), and `onContent('load')` reports the *real* disk
  content so the rename tracker treats the first authored title as a birth.
- `note-editor.tsx`: `selectTitle()` on the handle; `title-selection.ts`
  helper selects the first heading's text (macOS rename pattern), falling
  back to plain focus.
- `note-pane.tsx`: missing non-daily notes seed `# Untitled\n` and open with
  the title selected so typing names the note. Daily notes stay unseeded
  (the date is their identity); they're also excluded from rename tracking.
- `route-content.tsx`: extracted from `graph-workspace.tsx` verbatim so the
  seam is directly testable. `daily-stream.tsx` gained a testid.
- Seed choice: literal `# Untitled\n` (exact round-trip), **not** an empty
  heading — `'#\n\nbody\n'` classifies lossy and would flip new notes
  read-only.

### Tests (+20, all passing; 207 total)

- `note-session.test.ts` (+6): seed shown but unwritten, editor echo stays
  clean, first real edit creates the file and clears `missing`, no-seed daily
  contract, existing file ignores seed, external create adopts cleanly.
- `title-selection.test.ts` (+6): range over real meowdown docs, non-first
  heading, no/empty heading → null, command selects so typing replaces,
  false without dispatch.
- `route-content.test.tsx` (+8): real router → RouteContent → NotePane →
  session over a fake bridge (only the ProseMirror view stubbed):
  today/daily → stream; note route → editable pane (`Editing notes/…`), not
  the stream; missing note → seeded Untitled, `selectTitle`, zero writes on
  flush; typing creates the file; lossy note → read-only; settings; search
  arrival opens palette pre-filled.

### Verification

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK |
| `pnpm typecheck` | OK (3/3 packages) |
| `pnpm lint` | OK (oxlint, clean) |
| `pnpm test` | OK — 33 files, 207 tests |
| `pnpm build` | OK (pre-existing >500 kB chunk warning) |
| `pnpm tauri dev` | **Blocked**: no Rust toolchain on this machine (`cargo` not found) |
| `pnpm dev` (vite) | Boots, HTTP 200 on :1420 |

Browser-level interaction also infeasible (no browser-automation tooling in
this environment); the route-content integration suite is the compensating
coverage.

### Next

- Commit, push, open PR against `master`.
- Write `final-report.md` with the PR URL + SHAs.
