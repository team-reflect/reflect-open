# Plan 18 — Tasks (post-release add-on)

**Goal:** Port V1's third center of gravity — tasks embedded in notes, collected into
one view — as a **lightweight markdown-backed projection**, per the decision docs
(grounding brief §9.7 Option A: aggregate, schedule, complete; never a task manager).
A task is a round Meowdown checkbox in a note (`+ [ ]` / `+ [x]`); the Tasks view is
a projection over those rows, exactly like backlinks are a projection over `[[links]]`.
Square checklist checkboxes (`- [ ]` / `- [x]`) stay in the note and do not aggregate.

**Status:** Add-on — not part of the first macOS release. Build after launch.

**Depends on:** Plan 03 (parser/extraction), Plan 04 (index + watcher), Plan 05
(editor; step 8's upstream blocker is now **cleared** — see below), Plan 06 (daily
dates), Plan 08 (commands/palette), Plan 17 (path-keyed projections survive moves).
**Unlocks:** the V1 daily-capture → task-recall loop; future AI task extraction
(grounding brief §9.6) over a real projection.

## What changed since tasks were deferred

Tasks were deferred partly because meowdown's converter **lost task-item text**
(`+ [ ] todo` → empty list; Plan 05 step 8). That fix shipped: **meowdown 0.3.0
round-trips task lists byte-faithfully** (verified 2026-06-12 — `+ [ ] buy milk\n+ [x]
call mum\n` round-trips unchanged, including wiki links and tags inside the item), and
its ProseMirror schema already models tasks first-class: a `list` node with
`kind: "task"` and a `checked` attr. Task notes no longer open protected. What's
missing is purely Reflect-side: interactivity, extraction, projection, and the view.

## Scope

**In:** interactive editor checkboxes (click + keyboard); task extraction into a
rebuildable `tasks` projection; a Tasks route/view grouping open tasks across the
graph (Overdue / Today / Upcoming / Unscheduled, collapsed Completed); toggle-complete
from the view with a guarded surgical write-back; date scheduling via `[[YYYY-MM-DD]]`
links and daily-note inheritance; square checklist syntax excluded from aggregation.
**Out (explicitly — grounding brief §9.7 calls half-building this the worst path):**
recurrence, reminders, priorities, projects, statuses, dependencies, calendar sync,
external task integrations, editing task *text* inside the Tasks view, archived-state
markers in markdown, AI task extraction (later, over this projection), CLI
`reflect tasks` (later; trivial once the table exists).

## Key decisions / contracts

- **A task is a round Meowdown checkbox item.** `+ [ ] text` / `+ [x] text`. No
  typed-entity layer: the files stay meaningful in Meowdown and any markdown tool
  that preserves list markers. Lezer parses these as `Task`/`TaskMarker` via the
  GFM extension in `grammar.ts`; Reflect additionally checks the physical list marker.
- **V1's task-vs-checklist distinction maps to marker shape.** Round task checkboxes
  (`+ [ ]`) aggregate into Tasks. Square checklist checkboxes (`- [ ]`, `* [ ]`, and
  ordered checkbox items) remain ordinary note checklists and are excluded from the
  projection. No frontmatter opt-out or markdown migration is needed.
- **Scheduling is association, not metadata** — V1's own mechanism (scheduling a task
  inserted a daily-note backlink) restated in markdown. Scheduled date resolution, in
  order: (1) the first `[[YYYY-MM-DD]]` wiki link inside the item; (2) for tasks in a
  daily note, the note's own date (a task jotted today is "today", and becomes overdue
  tomorrow — the V1 "current daily context" behavior); (3) unscheduled. Rescheduling
  *is* editing the date link.
- **The `tasks` table is a pure projection** (rebuildable, wiped + rebuilt on schema
  bump), keyed by `notes(path)` with `ON UPDATE CASCADE ON DELETE CASCADE` like the
  other child tables — so Plan 17 moves and deletes need zero new handling.
- **Write-back is surgical and guarded.** Toggling from the Tasks view replaces
  exactly the three-character marker (`[ ]` ↔ `[x]`) at the indexed position **only
  if** the surrounding item text still matches what the index recorded. On mismatch
  (stale index, concurrent edit): refuse loudly and reindex — never a silent wrong
  write. Positions are **JS string indices (UTF-16 code units), the unit Lezer
  reports and `extract.ts` already uses** — never UTF-8 byte offsets. The toggle
  stays in string-land end-to-end (read string → splice → `note_write` the whole
  string), so no byte conversion ever exists to get wrong.
- **The Tasks view is local-only**, so `private: true` notes' tasks appear in it (same
  contract as local search/retrieval). Any future exposure of tasks to chat tools goes
  through the existing `CloudSafe` checkers like every other note-content path.
- **Completion is the only state.** No archive flag — markdown has no clean home for
  it. The view shows checked tasks in a collapsed "Completed" section (recent first);
  hiding old completed tasks is presentation, not data.

### Contract sketches

```ts
// extract.ts — ParsedNote grows:
interface ParsedTask {
  text: string          // inline text of the item's first paragraph, markdown stripped
  raw: string           // exact source slice of that line (the write-back guard)
  checked: boolean
  markerOffset: number  // string index of `[ ]`/`[x]` in the source — UTF-16 code
                        // units, as Lezer positions are (never UTF-8 bytes)
  scheduled: string | null // ISO date per the resolution rules above
}

// markdown/edit.ts — the guarded toggle (pure; the command wraps read→edit→write):
export function toggleTaskMarker(
  source: string,
  markerOffset: number,
  expectedRaw: string,
): { source: string; checked: boolean } // throws TaskStaleError on any mismatch
```

```sql
-- crates/index-schema/migrations/0009_tasks.sql (+ LATEST_SCHEMA_VERSION bump →
-- projection wipe/rebuild on first open; chat_* untouched as always)
CREATE TABLE tasks (
  note_path     TEXT NOT NULL REFERENCES notes(path)
                  ON UPDATE CASCADE ON DELETE CASCADE,
  marker_offset INTEGER NOT NULL,  -- JS string index (UTF-16 units), not bytes
  text          TEXT NOT NULL,
  raw           TEXT NOT NULL,
  checked       INTEGER NOT NULL,
  scheduled     TEXT,             -- ISO date or NULL
  PRIMARY KEY (note_path, marker_offset)
);
CREATE INDEX tasks_open_by_date ON tasks (checked, scheduled);
```

```ts
// route.ts — Route union grows (exhaustive switches force the rest):
| { kind: 'tasks' }
```

## Steps

1. **Editor: interactive checkboxes (Plan 05 step 8, unblocked).** The schema attr
   (`list` `kind:"task"` / `checked`) already exists; wire interactivity in the
   meowdown surface file (`editor/meowdown.ts` stays the single coupling point):
   checkbox click toggles `checked`; `⌘⏎` toggles the task under the caret and
   converts a plain bullet to a task (V1 muscle memory) — registered through the
   editor keymap registry (audit meowdown's own bound shortcuts first). Verify
   serialization stays marker-only (`[ ]`↔`[x]`), pinned by round-trip tests.

2. **Extraction.** Extend `parseNote` with `tasks: ParsedTask[]` from the Lezer
   `Task`/`TaskMarker` nodes (skip code blocks as elsewhere). Resolve `scheduled`
   here: first `[[YYYY-MM-DD]]` in the item, else `dateFromDailyPath`, else null.

3. **Projection.** Migration `0009_tasks.sql` (above) + Kysely schema regen + the
   Rust `index_apply` payload/write path (`db/write.rs`). Only extracted `+ [ ]` task
   rows enter the table; square checklist rows never reach the projection.

4. **Toggle write path.** `toggleTaskMarker` in `markdown/edit.ts` (pure, tested);
   a core command (`indexing/commands.ts` family) doing read → toggle → `note_write`
   → reindex, surfacing `TaskStaleError` as a reviewable refusal. If the note is open
   in the editor, the existing external-change reconciliation picks the write up.

5. **Task vs checklist marker contract.** Extraction accepts only task-list rows whose
   physical marker is `+`; `-`, `*`, ordered checkbox items, and fenced-code examples
   stay out of `ParsedNote.tasks`. Bump extraction/projection versions whenever this
   contract changes so unchanged notes rebuild correctly.

6. **Tasks route + view.** `{ kind: 'tasks' }` route; sidebar entry; `⌘T` (free) +
   "Go to tasks" palette command. The view: TanStack Query over the projection,
   invalidated on `index:changed` like the backlinks panel; groups Overdue / Today /
   Upcoming / Unscheduled with source-note titles (daily dates render as dates);
   collapsed Completed section; checkbox toggles via step 4; row click navigates via
   `routeForPath`. Keyboard: arrows + space/enter to toggle, full flow mouse-free.
   Virtualize only if a real graph proves it necessary (note the parent-owned scroll
   container must be virtualizer *state*, not a ref, if so).

7. **Tests.** Extraction (positions, scheduling precedence, code-block skips,
   checklist flag); toggle round-trip incl. the stale-guard refusal; editor checkbox
   click/keymap + serialization fidelity; view grouping + invalidation; move/rename
   keeps task rows (FK cascade); rebuild-from-markdown reproduces the table.

## Acceptance criteria

- `+ [ ]` renders as a clickable task checkbox in the editor; click and `⌘⏎` toggle it;
  the file changes by exactly the marker characters; `pnpm typecheck` + targeted
  tests pass.
- `⌘T` opens Tasks: every open `+ [ ]` task across the graph, excluding square
  checklists, grouped Overdue / Today / Upcoming / Unscheduled, with source-note
  context; completed tasks sit collapsed below; the whole flow works without the mouse.
- A task containing `[[2026-07-01]]` schedules for that date; a bare task in
  `daily/2026-06-12.md` schedules for 2026-06-12 and turns Overdue the next day; a
  bare task in a regular note is Unscheduled.
- Toggling from the Tasks view updates the markdown file, the index, and an open
  editor; toggling against a stale index refuses loudly and recovers via reindex —
  never writes a wrong edit.
- Deleting `.reflect/` and reopening reproduces the identical tasks projection;
  renaming/moving a note keeps its task rows; external edits re-project within the
  watcher debounce.
- The Tasks view includes `private: true` notes (local surface); nothing task-related
  adds a new external call site.

## Risks

- **Interactivity may need more than an attr toggle** if meowdown/ProseKit doesn't
  expose checkbox clicks cleanly through `defineEditorExtension()`. Fallback is the
  proven house pattern: decorations over literal text, like wiki-links/images. Keep
  all meowdown contact inside `editor/meowdown.ts`.
- **Offset-keyed write-back races edits.** The `raw`-match guard + loud refusal is
  the defense; the acceptance test for the stale path is non-negotiable
  (fail-loud, never silent-wrong).
- **Serializer normalizations vs the protection guard.** meowdown normalizes
  `[X]`→`[x]` and loose single-paragraph lists→tight (accepted, pinned in tests);
  externally-authored files using those shapes open protected today and will continue
  to — note it in docs, don't fight it here.
- **Scope creep is the historical failure mode** (grounding brief §9.7): V1 grew
  task editing inside the view, pending inline task documents, and archive state.
  Everything in **Out** stays out until a deliberate later plan.
- **Daily-date inheritance might over-schedule** for users who journal tasks in daily
  notes without meaning "due today". Escape hatches: use square checklist syntax for
  non-task lists, or an explicit future `[[date]]` on the item. Revisit only with real
  usage.
