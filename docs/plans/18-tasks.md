# Plan 18 — Tasks (post-release add-on)

**Goal:** Port V1's third center of gravity (tasks embedded in notes, collected into one
view) as a **lightweight Markdown-backed projection**, per grounding brief §9.7
Option A: aggregate, schedule, complete; never a task manager. A task is a round
Meowdown checkbox (`+ [ ]` / `+ [x]`); the Tasks view projects those rows the way
backlinks project `[[links]]`. Square checklists (`- [ ]` / `- [x]`) stay in the note and
do not aggregate.

**Status:** Add-on, not part of the first macOS release. Build after launch.

**Depends on:** Plan 03 (extraction), Plan 04 (index + watcher), Plan 05 (editor; step 8's
upstream blocker is **cleared**), Plan 06 (daily dates), Plan 08 (palette), Plan 17
(path-keyed projections survive moves).
**Unlocks:** the V1 daily-capture → task-recall loop; future AI task extraction
(grounding brief §9.6) over a real projection.

## What changed since tasks were deferred

Tasks were deferred partly because meowdown's converter **lost task-item text**
(`+ [ ] todo` → empty list). **meowdown 0.3.0 round-trips task lists byte-faithfully**
(verified 2026-06-12, including wiki links and tags inside items) and models tasks as a
`list` node with `kind: "task"` and `checked`. Task notes no longer open protected. What
remained was Reflect-side: interactivity, extraction, projection, and the view.

## Scope

**In:** interactive editor checkboxes (click + keyboard); a rebuildable `tasks`
projection; a Tasks view grouping open tasks (Overdue / Today / Upcoming / Unscheduled,
collapsed Completed); toggle-complete from the view with a guarded surgical write-back;
scheduling via `[[YYYY-MM-DD]]` links and daily-note inheritance; square checklists
excluded.
**Out (grounding brief §9.7 calls half-building this the worst path):** recurrence,
reminders, priorities, projects, statuses, dependencies, calendar sync, external
integrations, editing task *text* in the view, archive markers in Markdown, AI task
extraction (later), CLI `reflect tasks` (later; trivial once the table exists).

## Key decisions / contracts

- **A task is a round checkbox item.** No typed-entity layer: files stay meaningful in
  Meowdown and any Markdown tool that preserves list markers. Reflect checks the
  physical list marker on top of Lezer's GFM `Task` parse.
- **V1's task-vs-checklist distinction maps to marker shape.** `+ [ ]` aggregates;
  `- [ ]`, `* [ ]`, and ordered checkbox items stay ordinary checklists. No frontmatter
  opt-out or migration needed.
- **Scheduling is association, not metadata**: V1's mechanism (scheduling inserted a
  daily-note backlink) restated in Markdown. Date resolution, in order: (1) the first
  `[[YYYY-MM-DD]]` in the item; (2) for tasks in a daily note, that note's date (a task
  jotted today is "today" and overdue tomorrow, V1's "current daily context"); (3)
  unscheduled. Rescheduling *is* editing the date link.
- **The `tasks` table is a pure projection** (wiped + rebuilt on schema bump), keyed by
  `notes(path)` with cascading FKs like the other child tables, so Plan 17 moves and
  deletes need no new handling.
- **Breadcrumbs are the headings above the task, then its ancestor list items**,
  outermost first. Every heading level counts, so a breadcrumb reads like the note's
  outline; only top-level document headings open a section (`> ## Quoted` does not). The
  stored chain is complete; display hides only a lone generic parent (`Tasks`, `TODO:`,
  `To do`, …), since in a longer chain `Tasks` is a real outline level. A list label is
  the item's first paragraph; a parent task labels its subtasks. The view shows one
  `Parent → Child` row above each consecutive run of rows **of one note** with the same
  visible breadcrumbs, so two notes' `House chore` sections never merge (V1's context-row
  behavior). Search matches task text, note title, and breadcrumb labels. Desktop
  breadcrumb clicks select exactly the rows they label; mobile renders breadcrumbs as
  read-only labels because its Tasks tab has no multi-select.
- **Automatic inserts land in the `## Tasks` section.** Return-to-add, "+ Add", and
  browser captures insert into the first `+` list under the note's first top-level H1/H2
  that reads "Tasks" (`## Tasks`, `# Tasks`, `## [[Tasks]]`, `## **Tasks**`), directly
  under the heading if that list is missing, or a new `## Tasks` section after the
  note's last content (trailing blank lines stay below). Typing in the editor is
  unaffected; Enter on a row under a heading continues that row's own list.
- **Write-back is surgical and guarded.** A toggle edits only the targeted item, and only
  if its text and checked state still match what the index recorded. On mismatch (stale
  index, concurrent edit): refuse loudly and reindex, never a silent wrong write. The
  original sketch used character offsets; positions must be **JS string indices (UTF-16
  code units)**, never UTF-8 byte offsets, and the toggle stays in string-land
  end-to-end so no byte conversion exists to get wrong. Tasks are now addressed by
  block-AST path instead (`packages/core/src/markdown/task-ast.ts`).
- **The Tasks view is local-only**, so `private: true` notes' tasks appear (same contract
  as local search). Any future exposure to chat tools goes through the `CloudSafe`
  checkers.
- **Completion is the only state.** No archive flag (Markdown has no clean home for it).
  Checked tasks sit in a collapsed "Completed" section, recent first; hiding old ones is
  presentation, not data.

The projection and guarded edit live in `packages/core/src/markdown/task-ast.ts`; the
table in `crates/index-schema/migrations/` (`0011_tasks.sql` through
`0023_task_ast_path.sql`). The route union gains `{ kind: 'tasks' }`.

## Steps

1. **Interactive checkboxes (Plan 05 step 8, unblocked).** Wire interactivity in the
   meowdown surface file (the single coupling point): click toggles `checked`; `⌘⏎`
   toggles the task under the caret and converts a plain bullet to a task (V1 muscle
   memory), registered through the keymap registry (audit meowdown's own shortcuts
   first). Round-trip tests pin marker-only serialization.
2. **Extraction** in `parseNote`, skipping code blocks; resolve the due date here.
3. **Projection:** tasks migration + Kysely regen + Rust `index_apply` write path. Only
   `+ [ ]` rows enter the table.
4. **Write path:** a pure AST edit (resolve every locator against the pre-edit tree,
   mutate, serialize once). Desktop wraps it as read → edit → write → reindex, surfacing
   a stale error as a reviewable refusal; an open note takes the same transform through
   its editing session.
5. **Marker contract:** only `+` task rows aggregate. Bump extraction/projection versions
   whenever this contract changes so unchanged notes rebuild.
6. **Tasks view:** sidebar entry, `⌘T`, "Go to tasks" palette command. Query over the
   projection invalidated on `index:changed` like backlinks; groups with source-note
   titles (daily dates render as dates); collapsed Completed; row click navigates.
   Fully mouse-free. Virtualize only if a real graph needs it (then the parent-owned
   scroll container must be virtualizer *state*, not a ref).
7. **Tests:** extraction (scheduling precedence, code-block skips, checklist exclusion),
   toggle round-trip incl. stale refusal, editor serialization fidelity, view grouping +
   invalidation, move/rename keeps rows (FK cascade), rebuild reproduces the table.

## Acceptance criteria

- `+ [ ]` is a clickable editor checkbox; click and `⌘⏎` toggle it; the file changes by
  exactly the marker characters.
- `⌘T` opens every open `+ [ ]` task across the graph, excluding square checklists,
  grouped with source-note context; completed tasks collapsed below; works without the
  mouse.
- `[[2026-07-01]]` in a task schedules it then; a bare task in `daily/2026-06-12.md`
  schedules for 2026-06-12 and turns Overdue the next day; a bare task in a regular note
  is Unscheduled.
- Toggling from the view updates the file, index, and an open editor; a stale index
  refuses loudly and recovers via reindex.
- Deleting `.reflect/` reproduces the identical projection; rename/move keeps rows;
  external edits re-project within the watcher debounce.
- `private: true` tasks appear in the view; nothing task-related adds an external call.

## Risks

- **Interactivity may need more than an attr toggle** if meowdown does not expose
  checkbox clicks cleanly. Fallback is the house pattern: decorations over literal text,
  like wiki-links/images. Keep all meowdown contact in one file.
- **Write-back races edits.** The text + checked guard and loud refusal are the defense;
  the stale-path acceptance test is non-negotiable. A format-only rewrite does not move
  an AST path; only adding or removing blocks above the task does.
- **Serializer normalizations vs the protection guard.** meowdown normalizes `[X]`→`[x]`
  and loose single-paragraph lists→tight (accepted, pinned in tests); external files in
  those shapes open protected. Document it; do not fight it here.
- **Scope creep is the historical failure mode** (§9.7): V1 grew in-view task editing,
  pending inline task documents, and archive state. **Out** stays out until a deliberate
  later plan.
- **Daily-date inheritance might over-schedule** for users who journal tasks without
  meaning "due today". Escape hatches: square checklists, or an explicit future
  `[[date]]`. Revisit with real usage.
