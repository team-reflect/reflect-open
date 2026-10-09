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
- **Task context breadcrumbs are the headings above the task, then its ancestor
  list items**, outermost first. Every heading level counts (`# Home` →
  `## House chore` → `### Garden`), so a breadcrumb reads like the note's outline;
  only headings that are direct blocks of the document open a section (`> ## Quoted`
  does not). The stored chain is complete, the app's own `## Tasks` heading included;
  display hides only a lone generic parent (`Tasks`, `TODO:`, `To do`, …), since a
  longer chain's `Tasks` is a real level of the outline (`visibleTaskBreadcrumbs`). A list label is
  the item's first paragraph; a parent task labels its nested subtasks. The Tasks
  view shows one `Parent → Child` row above each consecutive run of rows **of one
  note** with the same visible breadcrumbs, so two notes' `House chore` sections
  never merge (V1's context-row behavior, not a per-row label). Storage is
  derived projection data: `tasks.breadcrumbs` holds one JSON string array written
  and read only through `encodeTaskBreadcrumbs`/`decodeTaskBreadcrumbs` (mirrored by
  `write.rs`). Task search matches task text, note title, and breadcrumb labels.
  Both desktop and mobile render the same context runs. Clicking a desktop breadcrumb
  selects exactly the rows it labels; mobile renders the breadcrumb as a read-only
  grouping label because its Tasks tab has no multi-select mode.
- **Automatic inserts land in the `## Tasks` section.** The Tasks view's
  Return-to-add and "+ Add", and browser task captures, insert into the first `+`
  list of the note's first top-level H1 or H2 that reads "Tasks" (`## Tasks`,
  `# Tasks`, `## [[Tasks]]`, `## **Tasks**`), directly under the heading when that
  list is missing, and append a new `## Tasks` section when the heading is missing.
  Typing in the editor is unaffected. Enter on a row that sits under a heading
  continues that row's own list in place.
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
// markdown/task-ast.ts: the projection (the historical sketch keyed tasks by a
// character offset plus the raw line; tasks are now addressed in the block AST):
interface ParsedTask {
  astPath: number[]     // child indexes from the body's AST root, e.g. [2, 1]
  markdown: string      // the item's first paragraph, marker excluded
  breadcrumbs: string[] // headings above the task, then ancestor items' first paragraphs, outermost first
  checked: boolean
  dueDate: string | null // ISO date per the resolution rules above
}

// markdown/task-ast.ts: the guarded edit (pure; the command wraps read, edit, write).
// Every locator describes the note as the index last saw it; a path hit must
// match `markdown` and `checked`, else a unique match, else TaskStaleError.
export function applyTaskEdits(source: string, edits: readonly TaskEdit[]): TaskEditResult
```

```sql
-- crates/index-schema/migrations/0023_task_ast_path.sql (projection wipe/rebuild
-- on first open; chat_* untouched as always)
CREATE TABLE tasks (
  note_path   TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  ast_path    TEXT NOT NULL,            -- JSON array of child indexes
  markdown    TEXT NOT NULL,            -- plain text is derived at read time
  checked     INTEGER NOT NULL,
  due_date    TEXT,                     -- ISO date or NULL
  breadcrumbs TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (note_path, ast_path)
);
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

4. **Write path.** `applyTaskEdits` in `markdown/task-ast.ts` (pure, tested):
   parse the body to meowdown's block AST, resolve every locator against the
   pre-edit tree, mutate, serialize once. The desktop wraps it as read → edit →
   `note_write` → reindex, surfacing `TaskStaleError` as a reviewable refusal; an
   open note takes the same transform through its session's `commitSourceEdit`.

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
- **Path-keyed write-back races edits.** The `markdown` + `checked` guard and loud
  refusal are the defense; the acceptance test for the stale path is non-negotiable
  (fail-loud, never silent-wrong). A format-only rewrite of the note does not move
  an AST path; only adding or removing blocks above the task does.
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
