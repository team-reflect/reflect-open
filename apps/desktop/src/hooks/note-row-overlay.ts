import { useCallback, useSyncExternalStore } from 'react'
import type { NoteRow } from '@reflect/core'

/**
 * The optimistic read overlay for note index rows (Plan 12 follow-up).
 *
 * The index lags an in-app frontmatter write by one watcher round-trip, so a
 * just-published note would briefly read as unpublished. Rather than each
 * surface (the gist action, the published-URL section, …) carrying its own
 * pending-state "bridge" — three near-duplicates, one of them with a
 * precedence bug — the optimism lives **once, in the read model**: an action
 * records what it just wrote, {@link useNoteRow} merges it over the index row,
 * and it retires the moment the index agrees. Every reader of `useNoteRow`
 * sees a single consistent value, so there is no second value to disagree.
 *
 * Each entry is keyed by graph-relative path and stamped with the **graph
 * generation** it was written under. A reader only sees overlays matching its
 * current generation, so a publish that resolves *after* a graph switch can't
 * surface on the new graph (its generation no longer matches) — a path shared
 * across graphs never shows the wrong note's url. {@link resetNoteRowOverlays}
 * on graph teardown is then just memory hygiene, not load-bearing for
 * correctness.
 */

/**
 * Index-row fields an action may assert ahead of the re-index. Publishing
 * yields a concrete `gistUrl` and a fresh `gistStale: false`; unpublishing
 * yields `gistUrl: null`. A pin or privacy flip yields the flag it just wrote
 * to frontmatter. These overlays are short-lived read-model facts that
 * retire as soon as the index catches up. As a *stored* value every field is
 * concrete — {@link definedFields} strips any `undefined` before it lands.
 */
export interface NoteRowOverlay {
  readonly gistUrl?: string | null
  readonly gistStale?: boolean
  readonly isPinned?: boolean
  readonly isPrivate?: boolean
}

/**
 * The shape callers may hand {@link setNoteRowOverlay}: the same fields, but
 * an explicit `undefined` is allowed (e.g. a conditionally-built patch). Such
 * fields are dropped by {@link definedFields}, so an all-`undefined` patch is a
 * no-op and `undefined` never reaches a stored {@link NoteRowOverlay}.
 */
export interface NoteRowOverlayPatch {
  readonly gistUrl?: string | null | undefined
  readonly gistStale?: boolean | undefined
  readonly isPinned?: boolean | undefined
  readonly isPrivate?: boolean | undefined
}

/**
 * Which fields {@link clearNoteRowOverlay} should drop. Named per field rather
 * than taken as a list so a caller can only ask for a field that exists, and
 * so retracting one action's assertion cannot touch another's.
 */
export interface NoteRowOverlayFields {
  readonly gistUrl?: boolean
  readonly gistStale?: boolean
  readonly isPinned?: boolean
  readonly isPrivate?: boolean
}

type MutableNoteRowOverlay = {
  -readonly [Key in keyof NoteRowOverlay]: NoteRowOverlay[Key]
}

interface OverlayEntry {
  /** The graph (file) generation this optimism was written under. */
  readonly generation: number
  readonly overlay: NoteRowOverlay
}

const overlays = new Map<string, OverlayEntry>()
const listeners = new Set<() => void>()

/**
 * {@link pinOverlays}'s result per generation, rebuilt lazily after each change.
 * `useSyncExternalStore` demands an `Object.is`-stable snapshot between emits,
 * which a freshly derived array never is, and memoizing at the call site does
 * not work: the React Compiler infers a memo's dependencies from what its body
 * actually reads, so a hand-written "revision" dependency the body ignores is
 * dropped and the derivation never re-runs. The cache belongs here instead.
 */
let pinOverlaySnapshots: Map<number, PinOverlay[]> | null = null

function emit(): void {
  pinOverlaySnapshots = null
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Strip `undefined` fields — an all-`undefined` patch must never be stored. */
function definedFields(patch: NoteRowOverlayPatch): NoteRowOverlay {
  const result: MutableNoteRowOverlay = {}
  if (patch.gistUrl !== undefined) {
    result.gistUrl = patch.gistUrl
  }
  if (patch.gistStale !== undefined) {
    result.gistStale = patch.gistStale
  }
  if (patch.isPinned !== undefined) {
    result.isPinned = patch.isPinned
  }
  if (patch.isPrivate !== undefined) {
    result.isPrivate = patch.isPrivate
  }
  return result
}

/**
 * Record an optimistic patch for `path` under the `generation` it was written
 * in, reflected by every `useNoteRow(path)` reader on that graph until the
 * index catches up. Merges with an existing patch from the same generation; a
 * patch from a newer generation replaces a stale one. An empty patch (or one
 * that is all `undefined`) is ignored — it would only leave a non-reconcilable
 * entry and leak `undefined` into merged rows.
 */
export function setNoteRowOverlay(
  path: string,
  generation: number,
  patch: NoteRowOverlayPatch,
): void {
  const defined = definedFields(patch)
  if (Object.keys(defined).length === 0) {
    return
  }
  const existing = overlays.get(path)
  // Never let an older generation's late write clobber a newer graph's overlay.
  // Rust already rejects stale-generation file writes before a publish reaches
  // here (the publish throws and never records an overlay), so this is defence
  // in depth — the store owns the invariant rather than trusting the caller.
  if (existing !== undefined && existing.generation > generation) {
    return
  }
  const base = existing?.generation === generation ? existing.overlay : {}
  overlays.set(path, { generation, overlay: { ...base, ...defined } })
  emit()
}

/**
 * The overlay for `path` on `generation`, or `null` when none applies. Readers
 * (here and {@link useNoteRowOverlay}) accept `undefined` — the graph may not
 * have loaded yet — and report no overlay; writers always hold a concrete
 * generation, so {@link setNoteRowOverlay}/{@link reconcileNoteRowOverlay}
 * require one. Keep that asymmetry: it is the load-state boundary, not an
 * inconsistency to unify.
 */
export function getNoteRowOverlay(
  path: string,
  generation: number | undefined,
): NoteRowOverlay | null {
  if (generation === undefined) {
    return null
  }
  const entry = overlays.get(path)
  return entry !== undefined && entry.generation === generation ? entry.overlay : null
}

/**
 * Drop overlay fields the freshly-read index `row` has caught up to (and the
 * whole entry once nothing is left). Called from {@link useNoteRow} in an
 * effect, never during render. A `null` row (note not indexed yet) or a
 * mismatched generation has nothing to reconcile, so the overlay is held.
 */
export function reconcileNoteRowOverlay(
  path: string,
  generation: number,
  row: NoteRow | null,
): void {
  const entry = overlays.get(path)
  if (entry === undefined || entry.generation !== generation || row === null) {
    return
  }
  const { gistUrl, gistStale, isPinned, isPrivate } = entry.overlay
  const remaining: MutableNoteRowOverlay = {}
  let retired = false
  if (gistUrl !== undefined) {
    if (row.gistUrl === gistUrl) {
      retired = true
    } else {
      remaining.gistUrl = gistUrl
    }
  }
  if (gistStale !== undefined) {
    if (row.gistStale === gistStale) {
      retired = true
    } else {
      remaining.gistStale = gistStale
    }
  }
  if (isPinned !== undefined) {
    if (row.isPinned === isPinned) {
      retired = true
    } else {
      remaining.isPinned = isPinned
    }
  }
  if (isPrivate !== undefined) {
    if (row.isPrivate === isPrivate) {
      retired = true
    } else {
      remaining.isPrivate = isPrivate
    }
  }
  if (!retired) {
    return
  }
  if (Object.keys(remaining).length === 0) {
    overlays.delete(path)
  } else {
    overlays.set(path, { generation, overlay: remaining })
  }
  emit()
}

/**
 * Drop the named fields for `path` without waiting for the index: the write
 * that asserted them failed, so the assertion must not stand. Fields the
 * caller does not name are left alone, because a pin and a publish can hold
 * assertions on one note at the same time.
 */
export function clearNoteRowOverlay(
  path: string,
  generation: number,
  fields: NoteRowOverlayFields,
): void {
  const entry = overlays.get(path)
  if (entry === undefined || entry.generation !== generation) {
    return
  }
  const remaining: MutableNoteRowOverlay = { ...entry.overlay }
  if (fields.gistUrl === true) {
    delete remaining.gistUrl
  }
  if (fields.gistStale === true) {
    delete remaining.gistStale
  }
  if (fields.isPinned === true) {
    delete remaining.isPinned
  }
  if (fields.isPrivate === true) {
    delete remaining.isPrivate
  }
  if (Object.keys(remaining).length === Object.keys(entry.overlay).length) {
    return // nothing the caller named was actually asserted
  }
  if (Object.keys(remaining).length === 0) {
    overlays.delete(path)
  } else {
    overlays.set(path, { generation, overlay: remaining })
  }
  emit()
}

/** One note's asserted pin state, for readers that show a list rather than a row. */
export interface PinOverlay {
  readonly path: string
  readonly isPinned: boolean
}

/** The stable "nothing asserted" result, so a reader can't churn on a fresh []. */
const NO_PIN_OVERLAYS: PinOverlay[] = []

/**
 * Every overlay on `generation` that asserts a pin state, for the sidebar's
 * pinned shelf: it lists notes by path and has no row query to merge over, so
 * it reads the assertions directly. The result is cached until the next change
 * (see {@link pinOverlaySnapshots}); subscribe to it with {@link usePinOverlays}.
 */
export function pinOverlays(generation: number | undefined): PinOverlay[] {
  if (generation === undefined) {
    return NO_PIN_OVERLAYS
  }
  pinOverlaySnapshots ??= new Map()
  const cached = pinOverlaySnapshots.get(generation)
  if (cached !== undefined) {
    return cached
  }
  const asserted: PinOverlay[] = []
  for (const [path, entry] of overlays) {
    if (entry.generation === generation && entry.overlay.isPinned !== undefined) {
      asserted.push({ path, isPinned: entry.overlay.isPinned })
    }
  }
  pinOverlaySnapshots.set(generation, asserted)
  return asserted
}

/**
 * Retire pin assertions the freshly-read pinned shelf already agrees with.
 * {@link reconcileNoteRowOverlay} only runs for a note something is rendering a
 * row for, and pinning a note does not open it, so without this a pin on a note
 * that is never opened would hold its assertion for the life of the graph.
 */
export function reconcilePinOverlays(generation: number, pinnedPaths: ReadonlySet<string>): void {
  let changed = false
  for (const [path, entry] of overlays) {
    const asserted = entry.overlay.isPinned
    if (entry.generation !== generation || asserted === undefined) {
      continue
    }
    if (asserted !== pinnedPaths.has(path)) {
      continue // the shelf has not caught up yet; hold the assertion
    }
    const remaining: MutableNoteRowOverlay = { ...entry.overlay }
    delete remaining.isPinned
    if (Object.keys(remaining).length === 0) {
      overlays.delete(path)
    } else {
      overlays.set(path, { generation, overlay: remaining })
    }
    changed = true
  }
  if (changed) {
    emit()
  }
}

/** Drop every overlay — graph teardown reclaims memory (correctness is by generation). */
export function resetNoteRowOverlays(): void {
  if (overlays.size === 0) {
    return
  }
  overlays.clear()
  emit()
}

/**
 * Merge an overlay over an index row. The overlay only sharpens an existing
 * row; with no row there is nothing to display yet (a publish targets an
 * already-indexed note), so `null` passes through.
 */
export function applyNoteRowOverlay(
  row: NoteRow | null,
  overlay: NoteRowOverlay | null,
): NoteRow | null {
  if (row === null || overlay === null) {
    return row
  }
  return { ...row, ...overlay }
}

/** Subscribe a component to every pin assertion on `generation`. */
export function usePinOverlays(generation: number | undefined): PinOverlay[] {
  const getSnapshot = useCallback(() => pinOverlays(generation), [generation])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Subscribe a component to `path`'s overlay on `generation`; `null` when none. */
export function useNoteRowOverlay(
  path: string,
  generation: number | undefined,
): NoteRowOverlay | null {
  const getSnapshot = useCallback(() => getNoteRowOverlay(path, generation), [path, generation])
  return useSyncExternalStore(subscribe, getSnapshot)
}
