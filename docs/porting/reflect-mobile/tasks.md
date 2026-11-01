# Porting the Tasks tab

**v2 status: shipped** (`apps/desktop/src/mobile/screens/tasks.tsx` and the
`mobile/task-*` components): a Tasks tab over the desktop (Plan 18) task
getters, groups, and guarded write-backs, reused via the shared
queries/actions and `composeVisibleTaskGroups`. The touch surface is V1
mobile's: checkbox toggles with a light haptic, tap-to-quick-edit in a
bottom sheet (text, scheduling chips + month grid, complete, convert to
bullet, open note, delete), a filters sheet with desktop's bucket toggles +
"Show archived", per-group "+" add, and struck-until-archived completions.
Drag-between-groups scheduling is **not** ported: the sheet's date picker
covers rescheduling; revisit only if real usage misses the gesture.

## What V1 mobile does

Implementation: `client/screens/tasks/` (screen, `task-group-list.tsx`,
`task-item.tsx`, `edit-modal.tsx`, `filters-modal.tsx`) over the shared V1
task model (`client/models/task/`; tasks are nodes inside note documents,
collected into a derived list).

### The list

- A third tab. Tasks grouped **Overdue / Today / Upcoming / Done** (as on
  desktop V1), each with a title and count, collapsible.
- A row: square checkbox, title, and a gray label linking to the source
  note. Checking strikes through and mutes the row with a light haptic.
  Completed tasks can be archived out of view.
- The FAB is hidden in Tasks (`mobileView.isTasksView`).

### The mobile-native interactions

1. **Drag-and-drop scheduling**: dnd-kit with a PointerSensor and an 8 pt
   activation distance (so taps never start drags). Dragging over a group
   highlights it with a haptic; dropping reschedules (scheduling is a
   backlink to a daily note inside the task, as on desktop V1).
2. **Quick-edit modal**: tapping a task edits title, scheduling, and
   completion **without opening the source note**; edits write through to
   the task node.
3. **Scheduling picker**: a date picker in the modal for explicit due
   dates.

A filters modal narrows the list (status/date/tags).

### Not on mobile

No recurring tasks, subtasks, or keyboard scheduling: desktop-only or
nonexistent in V1.

## What changes in v2, and why

- **The data model is decided and shipped on desktop** (Plan 18): tasks are
  `- [ ]` checkboxes collected by the index, with V1-exact buckets
  (Overdue = explicit `[[date]]` only), `setTaskDueDate` scheduling, and
  toggle/convert actions. Mobile adds no model; it is a screen over
  `packages/core` task getters, like the All tab over search getters.
- **Reuse desktop's grouping and semantics verbatim** (V1 parity was
  already settled on desktop). The mobile work is interaction: touch
  checkboxes with haptics, the quick-edit sheet, and scheduling via a date
  picker instead of drag.
- **If drag-to-schedule is ever added, activation distance matters.** V1's
  8 pt threshold is the difference between "drag to schedule" and "every
  tap flickers a drag"; keep the constraint whatever the DnD library.
- Editing from the list uses the same note-session write path as any edit
  (no second write path), so the file-change seam and sync dirty-marking
  work for free.

## V1 → v2 mapping

| V1                                          | v2                                                            |
| ------------------------------------------- | -------------------------------------------------------------- |
| Task nodes in ProseMirror docs              | `- [ ]` markdown lines, indexed (desktop Plan 18, shipped)     |
| Overdue / Today / Upcoming / Done groups    | Desktop v2 buckets, reused verbatim                            |
| Drag between groups = reschedule            | Sheet date picker over `setTaskDueDate` (drag not ported)      |
| Quick-edit modal (edit without opening)     | Port: bottom sheet over the task's note session                |
| Square checkbox + haptic + strikethrough    | Port as-is                                                     |
| Filters modal                               | Follow desktop's filter set                                    |
| FAB hidden in Tasks                         | Daily-only capture menu is not mounted in Tasks                |
