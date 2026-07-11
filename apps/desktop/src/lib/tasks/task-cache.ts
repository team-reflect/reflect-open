import { parseNote, type OpenTask } from '@reflect/core'
import { type TaskMarkerOffsetChange } from '@/lib/note-task'
import { sameTask, taskKey } from '@/lib/tasks/task-identity'

/**
 * Pure transforms over a cached task list ({@link OpenTask}[]), the optimistic
 * shapes the Tasks view applies before the reindex reconciles. Each takes the
 * current list (possibly `undefined` when a query isn't loaded) and returns the
 * next, leaving `undefined` untouched so a not-loaded completed list (archived
 * off) is a no-op. They identify rows by {@link sameTask}, the same key the
 * React rows and the mutations use, so an optimistic edit can't target the wrong
 * row. Kept apart from the mutation hooks so they're unit-testable directly and
 * shared by every Tasks write — single-row and bulk alike.
 */

/** Drop every row matching one of `tasks` from a cached list. */
export function withoutTasks(
  rows: OpenTask[] | undefined,
  tasks: OpenTask[],
): OpenTask[] | undefined {
  return rows?.filter((row) => !tasks.some((task) => sameTask(row, task)))
}

function markerChangeForTask(
  task: OpenTask,
  changes: readonly TaskMarkerOffsetChange[],
  matchUniqueRaw: boolean,
): TaskMarkerOffsetChange | undefined {
  const exact = changes.find(
    (change) => change.from === task.markerOffset && change.fromRaw === task.raw,
  )
  if (exact !== undefined) {
    return exact
  }
  if (!matchUniqueRaw) {
    return undefined
  }
  const rawMatches = changes.filter((change) => change.fromRaw === task.raw)
  return rawMatches.length === 1 ? rawMatches[0] : undefined
}

interface TaskMarkerRelocationOptions {
  /** Relocate a stale offset when its raw marker has exactly one source match. */
  readonly matchUniqueRaw?: boolean
}

interface TaskLineProjection {
  readonly text: string
  readonly dueDate: string | null
}

function taskLineProjection(raw: string): TaskLineProjection {
  const projected = parseNote({ path: '', source: `+ ${raw}` }).tasks[0]
  return {
    text: projected?.text ?? '',
    dueDate: projected?.dueDate ?? null,
  }
}

/**
 * Re-key cached rows after a contextual note write shifts marker offsets. Exact
 * offset + raw identity is the default. A caller holding a stale shadow row can
 * opt into unique-raw matching; query caches must not because their optimistic
 * anchor edit may now share another task's original raw.
 */
export function withRelocatedTaskMarkers(
  rows: OpenTask[] | undefined,
  notePath: string,
  changes: readonly TaskMarkerOffsetChange[],
  options?: TaskMarkerRelocationOptions,
): OpenTask[] | undefined
export function withRelocatedTaskMarkers(
  rows: readonly OpenTask[],
  notePath: string,
  changes: readonly TaskMarkerOffsetChange[],
  options?: TaskMarkerRelocationOptions,
): readonly OpenTask[]
export function withRelocatedTaskMarkers(
  rows: readonly OpenTask[] | undefined,
  notePath: string,
  changes: readonly TaskMarkerOffsetChange[],
  options: TaskMarkerRelocationOptions = {},
): readonly OpenTask[] | undefined {
  if (rows === undefined || changes.length === 0) {
    return rows
  }
  let changed = false
  const relocated = rows.flatMap((task) => {
    if (task.notePath !== notePath) {
      return [task]
    }
    const change = markerChangeForTask(task, changes, options.matchUniqueRaw === true)
    if (change === undefined) {
      return [task]
    }
    const { marker } = change
    if (marker === null) {
      changed = true
      return []
    }
    if (marker.markerOffset === task.markerOffset && marker.raw === task.raw) {
      return [task]
    }
    changed = true
    return [
      {
        ...task,
        ...marker,
        ...(marker.raw === task.raw ? {} : taskLineProjection(marker.raw)),
      },
    ]
  })
  return changed ? relocated : rows
}

/**
 * The same task line with its checkbox flipped to `checked` — the marker rewritten
 * in `raw` to match. An optimistic checked/reopened row MUST carry this, not the
 * pre-toggle `raw`: the write-back locates the line by `raw`, so a struck row
 * still holding `[ ]` while disk has `[x]` would fail `locateTaskMarker` on the
 * next reopen/edit/delete. The marker always begins `raw`, so slice past it.
 */
export function withCheckedMarker(task: OpenTask, checked: boolean): OpenTask {
  return { ...task, checked, raw: `${checked ? '[x]' : '[ ]'}${task.raw.slice(3)}` }
}

/**
 * Move `tasks` to the front of the completed list as checked, de-duping any
 * already present — the optimistic shape of completing them with archived on, so
 * the rows stay visible struck through instead of vanishing until the refetch.
 */
export function asCompleted(
  rows: OpenTask[] | undefined,
  tasks: OpenTask[],
): OpenTask[] | undefined {
  if (rows === undefined) {
    return rows
  }
  const kept = rows.filter((row) => !tasks.some((task) => sameTask(row, task)))
  return [...tasks.map((task) => withCheckedMarker(task, true)), ...kept]
}

/**
 * Move `tasks` into the open list as unchecked, de-duping any already present.
 * The open-tasks query is the primary Tasks view data source, so a not-yet-loaded
 * list materializes as just the reopened rows.
 */
export function asOpen(rows: OpenTask[] | undefined, tasks: OpenTask[]): OpenTask[] {
  const reopened = tasks.map((task) => withCheckedMarker(task, false))
  const reopenedKeys = new Set(reopened.map(taskKey))
  return [...(rows ?? []).filter((row) => !reopenedKeys.has(taskKey(row))), ...reopened]
}

/**
 * The `raw` line a task would have after an inline edit: the indexed line's exact
 * marker kept, the content after it replaced. The marker is taken verbatim from
 * `raw` (not rebuilt from `checked`), so GitHub's `[X]` survives; a CRLF raw line
 * likewise keeps its trailing carriage return. Otherwise a follow-up edit/delete
 * would fail the staleness guard until reindexing. Empty content clears to a bare
 * marker, matching the disk edit ({@link editTaskLine}).
 */
export function taskRawWithContent(task: OpenTask, content: string): string {
  const marker = task.raw.slice(0, 3) // `[ ]` / `[x]` / `[X]` — raw always begins with it
  const carriageReturn = task.raw.endsWith('\r') ? '\r' : ''
  return content === '' ? `${marker}${carriageReturn}` : `${marker} ${content}${carriageReturn}`
}

/**
 * The plain text the indexer would derive for a task line — markdown stripped,
 * wiki links flattened — by reparsing the rebuilt line through the same path the
 * projection uses. So the optimistic `text` (search + a11y) matches what the
 * reindex will store, not the raw markdown the editor produced.
 */
function plainTextOfTaskLine(raw: string): string {
  return taskLineProjection(raw).text
}

/**
 * Rewrite one task's content (and its `raw`) in a cached list before the reindex
 * re-derives it. The row keeps its place — the bucket only moves once the index
 * re-reads any due date — but shows the new text, with its rebuilt `raw` keeping
 * the next edit's staleness guard honest and its `text` carrying the *plain*
 * rendering (so search and the row label never see raw `[[…]]`/markup).
 */
export function withEditedTask(
  rows: OpenTask[] | undefined,
  task: OpenTask,
  content: string,
): OpenTask[] | undefined {
  const raw = taskRawWithContent(task, content)
  const text = plainTextOfTaskLine(raw)
  return rows?.map((row) => (sameTask(row, task) ? { ...row, raw, text } : row))
}
