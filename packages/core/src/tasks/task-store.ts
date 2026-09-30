import { parseMarkdownAst } from '@meowdown/markdown'
import { clearTaskDueDate, setTaskDueDate } from '../markdown/edit.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import type { ParsedTask } from '../markdown/model.ts'
import { inlineMarkdownToDisplayText } from '../markdown/plain-text.ts'
import { taskDueDate } from '../markdown/task-due-date.ts'
import { editTaskDocument } from '../markdown/task-mutation.ts'
import { encodeTaskPath } from '../markdown/task-path.ts'
import { projectTaskDocument } from '../markdown/task-projection.ts'

/** A task as the Tasks surfaces show it. Index rows and tasks created locally share this shape. */
export interface Task {
  /**
   * Identity: `notePath#astPath` for an indexed task, a random id for one
   * created here until the index lists it.
   */
  key: string
  notePath: string
  /**
   * Child indexes from the note body's AST root. For a task created here it is
   * provisional (just after the task it follows, or at the end) until written.
   */
  astPath: readonly number[]
  /** Raw first-paragraph Markdown, without the `[ ]` or `[x]` marker. */
  text: string
  /** Plain display text derived from `text`. */
  displayText: string
  checked: boolean
  dueDate: string | null
  /** Ancestor list-item labels, outermost first. */
  breadcrumbs: readonly string[]
  noteTitle: string
  dailyDate: string | null
  isPinned: boolean
  pinnedOrder: number | null
  updatedAt: number
}

/** What a task should become. `dueDate` rewrites the text's `[[YYYY-MM-DD]]` link. */
export interface TaskPatch {
  text?: string | undefined
  checked?: boolean | undefined
  dueDate?: string | null | undefined
  /** Leave the note as a checkbox: delete the line, or keep it as a plain bullet. */
  gone?: 'removed' | 'bullet' | undefined
}

/** What the store needs from the host to read and write notes. */
export interface TaskStoreIO {
  /** The note's current source, or null when the file does not exist. */
  read: (path: string) => Promise<string | null>
  /**
   * Replace the note atomically; must fail when the note no longer equals
   * `before`. Resolves once the index and the task queries reflect the write,
   * with the source actually saved when the host normalized it.
   */
  write: (path: string, before: string | null, source: string) => Promise<string | void>
  /** Some of a note's changes could not be saved; `retry` tries them again. */
  failure: (path: string, error: unknown, retry: () => void) => void
  /** A note's changes are all on disk. */
  saved: (path: string) => void
}

/** The note a new task goes into, with the metadata its row shows before the index has it. */
export type TaskTarget = Pick<
  Task,
  'notePath' | 'noteTitle' | 'dailyDate' | 'isPinned' | 'pinnedOrder'
> & { breadcrumbs?: readonly string[] | undefined }

/** Where a task was last seen in its note. */
interface Location {
  path: readonly number[]
  text: string
}

/** Everything the store knows about one task beyond the index. */
interface Entry {
  /** Where the task is in the note, remapped after every own write. Null until a task created here is written. */
  at: Location | null
  /** True for a task created here, whose key is not an index key. */
  created: boolean
  /** The task as it should be. A new object on every change. */
  row: Task
  /** The `row` the last write saved. The entry is pending while it differs from `row`. */
  saved: Task
  /** The task should leave the note as a checkbox. */
  gone?: 'removed' | 'bullet' | undefined
  /** For a task created here: the task it is inserted after, at its last known location. */
  after?: Task | undefined
  /** Text typed into an open editor, until the edit ends. */
  draft?: string | undefined
  /** Completed here; stays listed, struck, until archived. */
  recent?: boolean | undefined
  /** The last write could not take this change; cleared by a retry or a further change. */
  error?: unknown
}

interface Note {
  running: Promise<void> | null
  /** The source last read or written, to tell an outside change from our own. */
  source?: string | null | undefined
}

/** The key of an indexed task. */
export function indexedTaskKey(notePath: string, astPath: readonly number[]): string {
  return `${notePath}#${encodeTaskPath(astPath)}`
}

function samePath(left: readonly number[], right: readonly number[]): boolean {
  return encodeTaskPath(left) === encodeTaskPath(right)
}

/** `task` with `patch` applied. A date set on an empty task waits in `dueDate` for its first text. */
function patched(task: Task, patch: TaskPatch): Task {
  let text = patch.text ?? task.text
  if (patch.dueDate !== undefined && text.trim() !== '') {
    text = patch.dueDate === null ? clearTaskDueDate(text) : setTaskDueDate(text, patch.dueDate)
  }
  if (patch.text !== undefined && task.text.trim() === '' && task.dueDate && !taskDueDate(text)) {
    text = setTaskDueDate(text, task.dueDate)
  }
  return {
    ...task,
    text,
    displayText: inlineMarkdownToDisplayText(text),
    checked: patch.checked ?? task.checked,
    dueDate: text.trim() === '' ? (patch.dueDate ?? task.dueDate) : taskDueDate(text),
  }
}

/**
 * The task at `location`. Its path counts only while the note has not changed
 * since the store last saw it; otherwise, or when the path no longer holds
 * that text, the task must be the only one with its text.
 */
function find(
  tasks: readonly ParsedTask[],
  location: Location,
  trustPaths: boolean,
): ParsedTask | undefined {
  if (trustPaths) {
    const atPath = tasks.find((task) => samePath(task.astPath, location.path))
    if (atPath?.text === location.text) return atPath
  }
  const byText = tasks.filter((task) => task.text === location.text)
  return byText.length === 1 ? byText[0] : undefined
}

function conflict(): Error {
  return new Error('This task changed elsewhere. Your text is kept.')
}

/**
 * Every task change made outside a note's own editor goes through here: the
 * Tasks view, the mobile sheet, and backlink checkboxes. One instance serves
 * one graph.
 *
 * The index is the read model. The store keeps one `Entry` per task it knows
 * more about than the index: the task as it should be (`row`), what the last
 * write saved (`saved`; the entry is pending while the two differ), and where
 * the task sits in its note (`at`), which every own write remaps. `list`
 * overlays pending rows on the index rows; `update` changes a task's row and
 * schedules its note; the note's write loop reads the file, makes every
 * pending task look like its row, writes once, and marks the rows it wrote as
 * saved. `io.write` resolves only after the index and the task queries
 * reflect the write, so an entry is forgotten only once the index shows it.
 *
 * A task created here has a random key until the index lists it; the entry
 * maps the index row at its location back to that key while the entry lives.
 * Typing goes to `draft`, which stores text without notifying anyone;
 * `commitDraft` turns it into an update when the edit ends, and `update` folds
 * a pending draft in first, so a checkbox click during an edit acts on the
 * typed text. An emptied task, or an abandoned empty new task, is removed; an
 * empty new task is never written.
 *
 * A listed task completed through `update` stays listed, struck, until
 * `archive` (V1's middle state). A change the note cannot take waits with its own error,
 * reported once per note, without blocking the note's other changes; a retry
 * or a further change tries it again.
 */
export class TaskStore {
  private readonly entries = new Map<string, Entry>()
  private readonly notes = new Map<string, Note>()
  /** Keys the last `list` returned: only a listed task can become struck. */
  private listed = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  constructor(private readonly io: TaskStoreIO) {}

  /** Listen for changes to what `list` returns; pairs with `snapshot` for `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A counter that changes whenever `list` would return something new. */
  readonly snapshot = (): number => this.version

  /**
   * Save every open draft that has text, then resolve once no write loop is
   * running. An emptied draft is left alone: the editor decides what emptying
   * means when its edit ends.
   */
  readonly flush = async (): Promise<void> => {
    for (const entry of this.entries.values()) {
      if (entry.draft !== undefined && entry.draft.trim() !== '') this.commitDraft(entry.row)
    }
    for (;;) {
      const running = [...this.notes.values()].flatMap((note) =>
        note.running ? [note.running] : [],
      )
      if (running.length === 0) return
      await Promise.all(running)
    }
  }

  /**
   * The tasks to show: the open index rows, this session's completed tasks
   * (struck, until archived), the completed history when `completed` is given,
   * all with pending changes applied.
   */
  list(open: readonly Task[], completed?: readonly Task[]): Task[] {
    // Index rows of tasks created here take the key the UI already holds.
    const claims = new Map<string, string>()
    for (const [key, entry] of this.entries) {
      if (entry.at && key !== indexedTaskKey(entry.row.notePath, entry.at.path)) {
        claims.set(`${indexedTaskKey(entry.row.notePath, entry.at.path)}\n${entry.at.text}`, key)
      }
    }
    const rows = new Map<string, Task>()
    for (const task of [...open, ...(completed ?? [])]) {
      const key = claims.get(`${task.key}\n${task.text}`) ?? task.key
      rows.set(key, key === task.key ? task : { ...task, key })
    }
    for (const [key, entry] of this.entries) {
      if (entry.gone) {
        rows.delete(key)
        continue
      }
      // Without an index row, a task created here shows itself until the index
      // lists it; a struck one shows itself until archived.
      const pending = entry.row !== entry.saved
      const own = entry.created && (entry.at === null || pending)
      const base = rows.get(key) ?? (own || entry.recent ? entry.row : undefined)
      if (!base) continue
      const { text, displayText, checked, dueDate } = entry.row
      rows.set(key, pending ? { ...base, text, displayText, checked, dueDate } : base)
    }
    const listed = [...rows.values()].filter(
      (task) => !task.checked || completed !== undefined || this.entries.get(task.key)?.recent,
    )
    this.listed = new Set(listed.map((task) => task.key))
    return listed
  }

  /** Whether a task was completed in this session and is still listed struck. */
  isRecent(task: Task): boolean {
    const entry = this.entries.get(task.key)
    return entry?.recent === true && entry.row.checked
  }

  /** Stop listing this session's completed tasks. They stay `[x]` on disk. */
  archive(): void {
    for (const [key, entry] of this.entries) {
      entry.recent = false
      if (this.done(entry)) this.entries.delete(key)
    }
    this.emit()
  }

  /** The task as it should be now, including changes not written yet. */
  current(task: Task): Task {
    return this.entries.get(task.key)?.row ?? task
  }

  /**
   * Create an empty task and return it. With `after`, the task is inserted
   * right below that task and sorted there. Nothing is written until it has text.
   */
  create(target: TaskTarget, after?: Task): Task {
    const row: Task = {
      ...target,
      breadcrumbs: target.breadcrumbs ?? [],
      key: crypto.randomUUID(),
      astPath: [...(after?.astPath ?? []), Number.MAX_SAFE_INTEGER],
      text: '',
      displayText: '',
      checked: false,
      dueDate: null,
      updatedAt: Date.now(),
    }
    this.entries.set(row.key, { at: null, created: true, row, saved: row, after })
    this.emit()
    return row
  }

  /** Remember the text of an open editor. Notifies nobody and writes nothing. */
  draft(task: Task, text: string): void {
    this.entry(task).draft = text
  }

  /** Forget the open editor's text without saving it. */
  discardDraft(task: Task): void {
    const entry = this.entries.get(task.key)
    if (entry) entry.draft = undefined
  }

  /**
   * End an edit: save the draft when it changed the text, or remove the task
   * when it (or an untouched new task) is empty. Returns the task as it now
   * stands, or null when it was removed.
   */
  commitDraft(task: Task): Task | null {
    const entry = this.entries.get(task.key)
    const draft = entry?.draft
    if (entry) entry.draft = undefined
    if (entry?.gone) return null
    const text = (draft ?? entry?.row.text ?? task.text).trim()
    const untouchedNew = draft === undefined && entry?.at === null && text === ''
    if ((draft !== undefined && text === '') || untouchedNew) {
      this.update(task, { gone: 'removed' })
      return null
    }
    if (draft !== undefined && text !== this.current(task).text.trim()) this.update(task, { text })
    return this.current(task)
  }

  /**
   * Change what tasks should be, and schedule their notes. A draft still open
   * on a task is saved first. Completing a task keeps it listed, struck, until
   * `archive`.
   */
  update(tasks: Task | readonly Task[], patch: TaskPatch): void {
    for (const task of Array.isArray(tasks) ? (tasks as readonly Task[]) : [tasks as Task]) {
      const entry = this.entry(task)
      // A removal drops the draft; anything else, a bullet included, saves it first.
      if (patch.gone === 'removed') entry.draft = undefined
      else if (entry.draft !== undefined && this.commitDraft(task) === null) continue
      if (entry.gone) continue
      entry.row = patched(entry.row, patch)
      entry.error = undefined
      entry.gone = patch.gone
      if (patch.gone) entry.recent = false
      else if (patch.checked === true && this.listed.has(task.key)) entry.recent = true
      this.start(task.notePath)
    }
    this.emit()
  }

  private entry(task: Task): Entry {
    let entry = this.entries.get(task.key)
    if (!entry) {
      entry = {
        at: { path: task.astPath, text: task.text },
        created: false,
        row: task,
        saved: task,
      }
      this.entries.set(task.key, entry)
    }
    return entry
  }

  private note(path: string): Note {
    let note = this.notes.get(path)
    if (!note) {
      note = { running: null }
      this.notes.set(path, note)
    }
    return note
  }

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  /**
   * Nothing pending and nothing to remember. A task created here keeps its
   * entry, and so its key, while it stays in the note as a checkbox.
   */
  private done(entry: Entry): boolean {
    return (
      entry.row === entry.saved &&
      entry.draft === undefined &&
      entry.error === undefined &&
      !(entry.recent && entry.row.checked) &&
      (!entry.created || entry.gone !== undefined)
    )
  }

  /** Whether the change needs the file: everything but an unwritten task with no text, or its removal. */
  private writes(entry: Entry): boolean {
    return entry.at !== null || (entry.gone !== 'removed' && entry.row.text.trim() !== '')
  }

  private pending(path: string): [string, Entry][] {
    return [...this.entries].filter(
      ([, entry]) =>
        entry.row.notePath === path && entry.row !== entry.saved && entry.error === undefined,
    )
  }

  /** Run the note's write loop unless it is already running. */
  private start(path: string): void {
    const note = this.note(path)
    if (note.running) return
    note.running = this.drain(path, note).finally(() => {
      note.running = null
      if (this.pending(path).length > 0) this.start(path)
    })
  }

  /** Make the file match every pending task of the note, one read-edit-write round per batch. */
  private async drain(path: string, note: Note): Promise<void> {
    for (;;) {
      if (this.pending(path).length === 0) return
      // A new task without text has nothing to write, and removing it needs no
      // read either: such changes just count as saved.
      if (!this.pending(path).some(([, entry]) => this.writes(entry))) {
        for (const [, entry] of this.pending(path)) entry.saved = entry.row
        this.settle(path)
        this.emit()
        return
      }
      let disk: string | null
      try {
        disk = await this.io.read(path)
      } catch (failure) {
        for (const [, entry] of this.pending(path)) entry.error = failure
        this.report(path, failure)
        return
      }
      // The batch is taken after the read, so changes made meanwhile are in it.
      const batch = this.pending(path)
      const rows = new Map(batch.map(([key, entry]) => [key, entry.row]))
      const trustPaths = note.source === undefined || note.source === disk
      note.source = disk
      let source = disk ?? ''
      let tasks = projectTaskDocument(parseMarkdownAst(splitFrontmatter(source).body), true)
      // Where each task of the note is now, by entry key, and where each task
      // that was in the note at the read ended up, by its path then.
      let locations = new Map(
        [...this.entries].flatMap(([key, entry]) =>
          entry.at && entry.row.notePath === path ? [[key, entry.at] as const] : [],
        ),
      )
      const moved = new Map<string, readonly number[] | null>(
        tasks.map((task) => [encodeTaskPath(task.astPath), task.astPath]),
      )
      let error: unknown
      for (const [key, entry] of batch) {
        if (!this.writes(entry)) continue
        try {
          const applied = this.apply(locations, trustPaths, source, tasks, key, entry)
          source = applied.source
          tasks = applied.tasks
          locations = applied.locations
          for (const [start, current] of moved) {
            if (current !== null) {
              moved.set(start, applied.paths.get(encodeTaskPath(current)) ?? null)
            }
          }
        } catch (failure) {
          entry.error = failure
          error ??= failure
        }
      }
      if (source !== (disk ?? '')) {
        // The new locations show before the index refetch, so a written task is
        // never listed twice.
        const relocated = this.relocate(path, locations, moved)
        try {
          note.source = (await this.io.write(path, disk, source)) ?? source
          // Tasks touched during the write still hold paths from before it.
          this.relocate(path, locations, moved, relocated)
        } catch (failure) {
          for (const [entry, at] of relocated) entry.at = at
          for (const [, entry] of batch) entry.error = failure
          error = failure
        }
      }
      // What the batch wrote is what is saved now, even for a task changed
      // again meanwhile: its next write compares against this snapshot.
      for (const [key, entry] of batch) {
        if (entry.error === undefined) entry.saved = rows.get(key)!
      }
      this.settle(path)
      const stillFailing = [...this.entries.values()].some(
        (entry) => entry.row.notePath === path && entry.error !== undefined,
      )
      if (error !== undefined) {
        this.report(path, error)
        return
      }
      if (!stillFailing) this.io.saved(path)
      this.emit()
    }
  }

  /** Tell the host a batch failed; its retry clears the note's errors and runs the loop again. */
  private report(path: string, error: unknown): void {
    this.io.failure(path, error, () => {
      for (const entry of this.entries.values()) {
        if (entry.row.notePath === path) entry.error = undefined
      }
      this.start(path)
    })
    this.emit()
  }

  /**
   * Give the note's entries their location after the batch: the batch's own
   * results by key, any other entry by where its path moved. Returns the
   * entries relocated and their previous location, so a failed write can put
   * them back; entries in `skip` were relocated already.
   */
  private relocate(
    path: string,
    locations: ReadonlyMap<string, Location>,
    moved: ReadonlyMap<string, readonly number[] | null>,
    skip: readonly (readonly [Entry, Location | null])[] = [],
  ): (readonly [Entry, Location | null])[] {
    const skipped = new Set(skip.map(([entry]) => entry))
    const relocated: (readonly [Entry, Location | null])[] = []
    for (const [key, entry] of this.entries) {
      if (entry.row.notePath !== path || skipped.has(entry)) continue
      const own = locations.get(key)
      if (own === undefined && entry.at === null) continue
      relocated.push([entry, entry.at])
      if (own) entry.at = own
      else if (entry.gone) entry.at = null
      else if (entry.at) {
        const to = moved.get(encodeTaskPath(entry.at.path))
        if (to !== undefined) entry.at = to && { path: to, text: entry.at.text }
      }
    }
    return relocated
  }

  /**
   * After a write: tasks the index alone describes are forgotten, a task
   * created after a forgotten one remembers where that one was, and every
   * indexed task takes the key of its new location.
   */
  private settle(path: string): void {
    const own = [...this.entries].filter(([, entry]) => entry.row.notePath === path)
    for (const [key, entry] of own) {
      if (!this.done(entry)) continue
      this.entries.delete(key)
      for (const [, other] of own) {
        if (other.after?.key === key && entry.at) {
          other.after = { ...other.after, astPath: entry.at.path, text: entry.at.text }
        }
      }
    }
    const renamed = own.flatMap(([key, entry]) => {
      if (!this.entries.has(key) || entry.created || !entry.at) return []
      const next = indexedTaskKey(path, entry.at.path)
      return next === key ? [] : [[key, next, entry] as const]
    })
    for (const [key] of renamed) this.entries.delete(key)
    for (const [, next, entry] of renamed) {
      const unchanged = entry.row === entry.saved
      entry.row = { ...entry.row, key: next, astPath: entry.at!.path }
      entry.saved = unchanged ? entry.row : { ...entry.saved, key: next, astPath: entry.at!.path }
      this.entries.set(next, entry)
    }
  }

  /**
   * Make one task in `source` match its row, writing only the fields that
   * changed since the last save. Returns the new source, its tasks, every
   * batch task's new location, and the path map of this edit.
   */
  private apply(
    locations: ReadonlyMap<string, Location>,
    trustPaths: boolean,
    source: string,
    tasks: readonly ParsedTask[],
    key: string,
    { at, row, saved, gone, after }: Entry,
  ): {
    source: string
    tasks: ParsedTask[]
    locations: Map<string, Location>
    paths: ReadonlyMap<string, readonly number[]>
  } {
    const location = locations.get(key)
    if (at !== null && !location) throw conflict()
    const found = location && find(tasks, location, trustPaths)
    let result: ReturnType<typeof editTaskDocument>
    if (found) {
      result = editTaskDocument(
        source,
        gone === 'removed'
          ? { at: found.astPath, remove: true }
          : {
              at: found.astPath,
              text: row.text === saved.text ? found.text : row.text,
              checked: row.checked === saved.checked ? found.checked : row.checked,
              toBullet: gone === 'bullet',
            },
      )
    } else if (location) {
      if (gone === 'removed') {
        return { source, tasks: [...tasks], locations: new Map(locations), paths: new Map() }
      }
      throw conflict()
    } else {
      const anchorLocation =
        after && (locations.get(after.key) ?? { path: after.astPath, text: after.text })
      const anchor = anchorLocation && find(tasks, anchorLocation, trustPaths)
      result = editTaskDocument(source, {
        after: anchor?.astPath ?? null,
        create: { text: row.text, checked: row.checked, bullet: gone === 'bullet' },
      })
    }
    const next = new Map<string, Location>()
    for (const [id, previous] of locations) {
      const to = result.paths.get(encodeTaskPath(previous.path))
      if (to) next.set(id, { path: to, text: previous.text })
    }
    const landed = found ? result.paths.get(encodeTaskPath(found.astPath)) : result.createdPath
    if (landed && !gone) {
      const written = found && row.text === saved.text ? found.text : row.text
      next.set(key, { path: landed, text: written })
    } else next.delete(key)
    return { source: result.source, tasks: result.tasks, locations: next, paths: result.paths }
  }
}
