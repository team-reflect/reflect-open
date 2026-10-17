import type { GraphSessionSource } from '../graph/graph-session.ts'
import type { NoteRow, PinnedNote } from '../indexing/index-query-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { isValidPinOrder } from './pin-order.ts'

/**
 * Index-row fields an action may assert ahead of the re-index: a pin
 * (`isPinned`, `pinnedOrder`), a private toggle (`isPrivate`), a publish
 * (`gistUrl`, `gistStale`), and a trash (`trashed`: the note is gone from
 * lists until the index drops its row). These overlays are short-lived
 * read-model facts that retire as soon as the index catches up. As a *stored*
 * value every field is concrete: an `undefined` field is stripped before it
 * lands.
 */
export interface NoteRowOverlay {
  readonly isPinned?: boolean
  /**
   * The shelf order a pin wrote; `null` for a bare `pinned: true`.
   */
  readonly pinnedOrder?: number | null
  readonly isPrivate?: boolean
  readonly gistUrl?: string | null
  readonly gistStale?: boolean
  readonly trashed?: boolean
}

/**
 * The shape callers may hand {@link NoteRowService.setOverlay}: the same
 * fields, but an explicit `undefined` is allowed (e.g. a conditionally-built
 * patch). Such fields are dropped, so an all-`undefined` patch is a no-op and
 * `undefined` never reaches a stored {@link NoteRowOverlay}.
 */
export type NoteRowOverlayPatch = {
  readonly [Key in keyof NoteRowOverlay]?: NoteRowOverlay[Key] | undefined
}

/**
 * What an index read reports for a note: the overlay fields the read carries.
 * A field the read does not carry (`undefined`) is never compared.
 */
export type NoteRowFacts = {
  readonly [Key in Exclude<keyof NoteRowOverlay, 'trashed'>]?: NoteRowOverlay[Key] | undefined
}

/**

 * A listed note's {@link NoteRowFacts}, keyed by its path.

 */
export type NoteListRowFacts = NoteRowFacts & { readonly path: string }

export interface NoteRowReconcileOptions {
  /**
   * The rows are every note a trashed note could be listed under, so a path
   * missing from them is gone from the index and its `trashed` overlay retires.
   */
  readonly complete?: boolean
}

type MutableNoteRowOverlay = {
  -readonly [Key in keyof NoteRowOverlay]: NoteRowOverlay[Key]
}

const OVERLAY_KEYS = [
  'isPinned',
  'pinnedOrder',
  'isPrivate',
  'gistUrl',
  'gistStale',
  'trashed',
] as const satisfies readonly (keyof NoteRowOverlay)[]

const ROW_KEYS = [
  'isPinned',
  'pinnedOrder',
  'isPrivate',
  'gistUrl',
  'gistStale',
] as const satisfies readonly (keyof NoteRowFacts)[]

interface OverlayEntry {
  /**
   * The graph (file) generation this optimism was written under.
   */
  readonly generation: number
  readonly overlay: NoteRowOverlay
}

const EMPTY_OVERLAYS: ReadonlyMap<string, NoteRowOverlay> = new Map()

/**
 * The optimistic read overlay for note index rows (Plan 12 follow-up).
 *
 * The index lags an in-app frontmatter write by one watcher round-trip, so a
 * just-published, just-pinned, or just-trashed note would briefly read as it
 * was. Rather than each surface carrying its own pending-state "bridge", the
 * optimism lives **once, in the read model**: an action records what it just
 * wrote, the reader merges it over the index row, and it retires the moment
 * the index agrees. Every reader sees a single consistent value, so there is
 * no second value to disagree.
 *
 * Each entry is keyed by graph-relative path and stamped with the **graph
 * generation** it was written under. A reader only sees overlays matching its
 * current generation, so an action that resolves *after* a graph switch can't
 * surface on the new graph (its generation no longer matches): a path shared
 * across graphs never shows the wrong note's state. {@link NoteRowService.reset}
 * on graph teardown is then just memory hygiene, not load-bearing for
 * correctness. Readers and reconciles act on the open graph's generation;
 * writers pass the generation their action captured.
 */
export interface NoteRowService {
  /**
   * Record an optimistic patch for `path` under the `generation` it was written
   * in, reflected by every reader of that path on that graph until the index
   * catches up. Merges with an existing patch from the same generation; a
   * patch from a newer generation replaces a stale one. An unpin
   * (`isPinned: false`) drops a recorded `pinnedOrder`, and any patch without
   * `trashed` drops a recorded `trashed` (the note is acted on, so it exists).
   * An empty patch (or one that is all `undefined`) is ignored: it would only
   * leave a non-reconcilable entry and leak `undefined` into merged rows.
   */
  setOverlay(path: string, generation: number, patch: NoteRowOverlayPatch): void
  /**
   * Drop the fields of `patch` that `path` still holds with the same value on
   * `generation`: a failed action takes back its own optimism, and a later
   * action's value stays.
   */
  dropOverlay(path: string, generation: number, patch: NoteRowOverlayPatch): void
  /**
   * The overlay for `path` on the open graph, or `null` when none applies or no graph is open.
   */
  getOverlay(path: string): NoteRowOverlay | null
  /**
   * Every overlay on the open graph, by path. The same map is returned until
   * an overlay or the graph changes, so it is a stable snapshot for a store
   * subscription.
   */
  getOverlays(): ReadonlyMap<string, NoteRowOverlay>
  /**
   * Every overlay on `generation`, by path.
   */
  getOverlaysOn(generation: number): ReadonlyMap<string, NoteRowOverlay>
  /**
   * Drop overlay fields the freshly-read index `row` has caught up to (and the
   * whole entry once nothing is left). A `null` row means the index has no
   * row: a trashed note's entry retires, any other overlay is held (the note
   * may not be indexed yet). Only overlays on the open graph reconcile.
   */
  reconcile(path: string, row: NoteRowFacts | null): void
  /**
   * {@link NoteRowService.reconcile} for each listed row.
   */
  reconcileRows(rows: readonly NoteListRowFacts[], options?: NoteRowReconcileOptions): void
  /**
   * Drop every overlay: graph teardown reclaims memory (correctness is by generation).
   */
  reset(): void
  /**
   * Call `listener` whenever an overlay or the open graph changes.
   */
  subscribe(listener: () => void): Unlisten
}

/**

 * Strip `undefined` fields: an all-`undefined` patch must never be stored.

 */
function definedFields(patch: NoteRowOverlayPatch): MutableNoteRowOverlay {
  const result: Record<string, unknown> = {}
  for (const key of OVERLAY_KEYS) {
    if (patch[key] !== undefined) {
      result[key] = patch[key]
    }
  }
  return result
}

/**

 * Copy the `overlay` fields that `row` carries onto it; `null` when none changes a value.

 */
function mergeOverlay<Row extends object>(row: Row, overlay: NoteRowOverlay): Row | null {
  let merged: Row | null = null
  for (const key of ROW_KEYS) {
    const value = overlay[key]
    if (value !== undefined && key in row && Reflect.get(row, key) !== value) {
      merged ??= { ...row }
      Reflect.set(merged, key, value)
    }
  }
  return merged
}

/**
 * Merge an overlay over an index row. The overlay only sharpens an existing
 * row (only the fields a `NoteRow` has); with no row there is nothing to
 * display yet, so `null` passes through.
 */
export function applyNoteRowOverlay(
  row: NoteRow | null,
  overlay: NoteRowOverlay | null,
): NoteRow | null {
  if (row === null || overlay === null) {
    return row
  }
  return mergeOverlay(row, overlay) ?? row
}

/**
 * Merge the overlays over listed rows: a trashed note leaves the list, and a
 * field the row type carries takes the overlay's value. Returns `rows` itself
 * when nothing changes.
 */
export function applyNoteRowOverlays<Row extends { readonly path: string }>(
  rows: readonly Row[],
  overlays: ReadonlyMap<string, NoteRowOverlay>,
): readonly Row[] {
  if (overlays.size === 0) {
    return rows
  }
  let changed = false
  const result: Row[] = []
  for (const row of rows) {
    const overlay = overlays.get(row.path)
    if (overlay === undefined) {
      result.push(row)
    } else if (overlay.trashed === true) {
      changed = true
    } else {
      const merged = mergeOverlay(row, overlay)
      changed ||= merged !== null
      result.push(merged ?? row)
    }
  }
  return changed ? result : rows
}

function sortsAfter(order: number | null | undefined, other: number | null | undefined): boolean {
  if (!isValidPinOrder(other)) {
    return false
  }
  return !isValidPinOrder(order) || order > other
}

/**
 * Merge the overlays over the pinned shelf, keeping the index's order: an
 * unpinned or trashed note leaves it, a changed `pinnedOrder` moves its note,
 * and a newly pinned note joins where its order sorts (a bare pin goes last).
 * `preview` builds the shelf entry of a note the index does not list yet.
 * Returns `pinned` itself when nothing changes.
 */
export function applyPinnedNoteOverlays(
  pinned: readonly PinnedNote[],
  overlays: ReadonlyMap<string, NoteRowOverlay>,
  preview: (path: string) => PinnedNote,
): readonly PinnedNote[] {
  if (overlays.size === 0) {
    return pinned
  }
  let changed = false
  const shelf: PinnedNote[] = []
  for (const note of pinned) {
    const overlay = overlays.get(note.path)
    if (overlay?.trashed === true || overlay?.isPinned === false) {
      changed = true
    } else if (overlay?.pinnedOrder !== undefined && overlay.pinnedOrder !== note.pinnedOrder) {
      changed = true
      shelf.push({ ...note, pinnedOrder: overlay.pinnedOrder })
    } else {
      shelf.push(note)
    }
  }
  const listed = new Set(pinned.map((note) => note.path))
  for (const [path, overlay] of overlays) {
    if (overlay.isPinned === true && overlay.trashed !== true && !listed.has(path)) {
      changed = true
      shelf.push({ ...preview(path), pinnedOrder: overlay.pinnedOrder ?? null })
    }
  }
  if (!changed) {
    return pinned
  }
  // Stable insertion sort: notes the overlays did not move keep the index's order.
  const sorted: PinnedNote[] = []
  for (const note of shelf) {
    const at = sorted.findIndex((placed) => sortsAfter(placed.pinnedOrder, note.pinnedOrder))
    if (at === -1) {
      sorted.push(note)
    } else {
      sorted.splice(at, 0, note)
    }
  }
  return sorted
}

/**

 * The overlay with the fields `row` agrees with removed; `null` when none agrees.

 */
function retireAgreeing(overlay: NoteRowOverlay, row: NoteRowFacts): MutableNoteRowOverlay | null {
  const remaining: MutableNoteRowOverlay = { ...overlay }
  let retired = false
  for (const key of ROW_KEYS) {
    const value = row[key]
    if (value !== undefined && overlay[key] === value) {
      delete remaining[key]
      retired = true
    }
  }
  return retired ? remaining : null
}

export interface NoteRowServiceDeps {
  readonly graphSession: GraphSessionSource & { subscribe: (listener: () => void) => Unlisten }
}

class NoteRowServiceImpl implements NoteRowService {
  readonly #deps: NoteRowServiceDeps
  readonly #overlays = new Map<string, OverlayEntry>()
  readonly #listeners = new Set<() => void>()
  #snapshot: { generation: number; overlays: ReadonlyMap<string, NoteRowOverlay> } | null = null

  constructor(deps: NoteRowServiceDeps) {
    this.#deps = deps
  }

  setOverlay(path: string, generation: number, patch: NoteRowOverlayPatch): void {
    const defined = definedFields(patch)
    if (Object.keys(defined).length === 0) {
      return
    }
    const existing = this.#overlays.get(path)
    // Never let an older generation's late write clobber a newer graph's overlay.
    // Rust already rejects stale-generation file writes before an action reaches
    // here, so this is defence in depth: the store owns the invariant rather
    // than trusting the caller.
    if (existing !== undefined && existing.generation > generation) {
      return
    }
    const base: MutableNoteRowOverlay =
      existing?.generation === generation ? { ...existing.overlay } : {}
    if (defined.isPinned === false) {
      delete base.pinnedOrder
    }
    if (defined.trashed === undefined) {
      delete base.trashed
    }
    this.#overlays.set(path, { generation, overlay: { ...base, ...defined } })
    this.#emit()
  }

  dropOverlay(path: string, generation: number, patch: NoteRowOverlayPatch): void {
    const entry = this.#overlays.get(path)
    if (entry === undefined || entry.generation !== generation) {
      return
    }
    const remaining: MutableNoteRowOverlay = { ...entry.overlay }
    let dropped = false
    for (const [key, value] of Object.entries(definedFields(patch))) {
      const field = key as keyof NoteRowOverlay
      if (remaining[field] === value) {
        delete remaining[field]
        dropped = true
      }
    }
    if (dropped) {
      this.#store(path, generation, remaining)
      this.#emit()
    }
  }

  getOverlay(path: string): NoteRowOverlay | null {
    const generation = this.#openGeneration()
    if (generation === null) {
      return null
    }
    const entry = this.#overlays.get(path)
    return entry !== undefined && entry.generation === generation ? entry.overlay : null
  }

  getOverlays(): ReadonlyMap<string, NoteRowOverlay> {
    const generation = this.#openGeneration()
    if (generation === null) {
      return EMPTY_OVERLAYS
    }
    if (this.#snapshot?.generation !== generation) {
      this.#snapshot = { generation, overlays: this.#collect(generation) }
    }
    return this.#snapshot.overlays
  }

  getOverlaysOn(generation: number): ReadonlyMap<string, NoteRowOverlay> {
    return this.#snapshot?.generation === generation
      ? this.#snapshot.overlays
      : this.#collect(generation)
  }

  reconcile(path: string, row: NoteRowFacts | null): void {
    const generation = this.#openGeneration()
    if (generation !== null && this.#reconcileEntry(path, generation, row)) {
      this.#emit()
    }
  }

  reconcileRows(rows: readonly NoteListRowFacts[], options?: NoteRowReconcileOptions): void {
    const generation = this.#openGeneration()
    if (generation === null) {
      return
    }
    let changed = false
    for (const row of rows) {
      changed = this.#reconcileEntry(row.path, generation, row) || changed
    }
    if (options?.complete === true) {
      const listed = new Set(rows.map((row) => row.path))
      for (const [path, entry] of this.#overlays) {
        if (!listed.has(path) && entry.generation === generation) {
          changed = this.#reconcileEntry(path, generation, null) || changed
        }
      }
    }
    if (changed) {
      this.#emit()
    }
  }

  reset(): void {
    if (this.#overlays.size === 0) {
      return
    }
    this.#overlays.clear()
    this.#emit()
  }

  subscribe(listener: () => void): Unlisten {
    this.#listeners.add(listener)
    const stopGraph = this.#deps.graphSession.subscribe(listener)
    return () => {
      this.#listeners.delete(listener)
      stopGraph()
    }
  }

  #emit(): void {
    this.#snapshot = null
    for (const listener of this.#listeners) {
      listener()
    }
  }

  #store(path: string, generation: number, overlay: MutableNoteRowOverlay): void {
    if (Object.keys(overlay).length === 0) {
      this.#overlays.delete(path)
    } else {
      this.#overlays.set(path, { generation, overlay })
    }
  }

  #openGeneration(): number | null {
    return this.#deps.graphSession.getState().session?.generation ?? null
  }

  #collect(generation: number): ReadonlyMap<string, NoteRowOverlay> {
    const current = new Map<string, NoteRowOverlay>()
    for (const [path, entry] of this.#overlays) {
      if (entry.generation === generation) {
        current.set(path, entry.overlay)
      }
    }
    return current.size === 0 ? EMPTY_OVERLAYS : current
  }

  /**
   * Reconcile one entry without emitting; `true` when it changed.
   */
  #reconcileEntry(path: string, generation: number, row: NoteRowFacts | null): boolean {
    const entry = this.#overlays.get(path)
    if (entry === undefined || entry.generation !== generation) {
      return false
    }
    if (row === null) {
      if (entry.overlay.trashed !== true) {
        return false
      }
      this.#overlays.delete(path)
      return true
    }
    const remaining = retireAgreeing(entry.overlay, row)
    if (remaining === null) {
      return false
    }
    this.#store(path, generation, remaining)
    return true
  }
}

export function createNoteRowService(deps: NoteRowServiceDeps): NoteRowService {
  return new NoteRowServiceImpl(deps)
}
