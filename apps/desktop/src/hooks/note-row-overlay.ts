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
 * yields `gistUrl: null`. These overlays are short-lived read-model facts that
 * retire as soon as the index catches up.
 */
export interface NoteRowOverlay {
  readonly gistUrl?: string | null
  readonly gistStale?: boolean
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

function emit(): void {
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
function definedFields(patch: NoteRowOverlay): NoteRowOverlay {
  const result: MutableNoteRowOverlay = {}
  if (patch.gistUrl !== undefined) {
    result.gistUrl = patch.gistUrl
  }
  if (patch.gistStale !== undefined) {
    result.gistStale = patch.gistStale
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
export function setNoteRowOverlay(path: string, generation: number, patch: NoteRowOverlay): void {
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
export function getNoteRowOverlay(path: string, generation: number | undefined): NoteRowOverlay | null {
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
export function reconcileNoteRowOverlay(path: string, generation: number, row: NoteRow | null): void {
  const entry = overlays.get(path)
  if (entry === undefined || entry.generation !== generation || row === null) {
    return
  }
  const remaining: MutableNoteRowOverlay = {}
  let retired = false
  for (const key of Object.keys(entry.overlay) as (keyof NoteRowOverlay)[]) {
    if (row[key] === entry.overlay[key]) {
      retired = true
    } else if (key === 'gistUrl') {
      remaining.gistUrl = entry.overlay.gistUrl
    } else {
      remaining.gistStale = entry.overlay.gistStale
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
export function applyNoteRowOverlay(row: NoteRow | null, overlay: NoteRowOverlay | null): NoteRow | null {
  if (row === null || overlay === null) {
    return row
  }
  return { ...row, ...overlay }
}

/** Subscribe a component to `path`'s overlay on `generation`; `null` when none. */
export function useNoteRowOverlay(path: string, generation: number | undefined): NoteRowOverlay | null {
  const getSnapshot = useCallback(() => getNoteRowOverlay(path, generation), [path, generation])
  return useSyncExternalStore(subscribe, getSnapshot)
}
