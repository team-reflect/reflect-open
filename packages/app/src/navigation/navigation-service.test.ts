import { describe, expect, it } from 'vitest'
import { createNavigationService } from './navigation-service.ts'

describe('NavigationService', () => {
  it('starts on today with no history', () => {
    const navigation = createNavigationService()
    expect(navigation.getState().route).toEqual({ kind: 'today' })
    expect(navigation.getState().canBack).toBe(false)
    expect(navigation.getState().canForward).toBe(false)
  })

  it('navigate pushes; back and forward traverse the stack', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    expect(navigation.getState().route).toEqual({ kind: 'note', path: 'notes/a.md' })

    navigation.back()
    expect(navigation.getState().route).toEqual({ kind: 'daily', date: '2026-06-08' })
    expect(navigation.getState().canForward).toBe(true)

    navigation.forward()
    expect(navigation.getState().route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(navigation.getState().canForward).toBe(false)
  })

  it('navigating from a back position truncates the forward branch', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })
    navigation.navigate({ kind: 'daily', date: '2026-06-07' })
    navigation.back()
    navigation.navigate({ kind: 'search', query: 'x' })
    expect(navigation.getState().canForward).toBe(false)
    navigation.back()
    expect(navigation.getState().route).toEqual({ kind: 'daily', date: '2026-06-08' })
  })

  it('re-navigating to the current route is a no-op (no stack growth)', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })
    navigation.back()
    expect(navigation.getState().route).toEqual({ kind: 'today' })
    expect(navigation.getState().canBack).toBe(false)
  })

  it('back/forward at the edges are no-ops', () => {
    const navigation = createNavigationService()
    navigation.back()
    expect(navigation.getState().route).toEqual({ kind: 'today' })
    navigation.forward()
    expect(navigation.getState().route).toEqual({ kind: 'today' })
  })

  it('advances the synchronous navigation revision for every navigation intent', () => {
    const navigation = createNavigationService()
    const revision = (): number => navigation.navigationRevision()
    const initial = revision()

    // Even a same-route re-arrival is an intent (initial route is today).
    navigation.navigate({ kind: 'today' })
    expect(revision()).toBe(initial + 1)
    navigation.navigate({ kind: 'tasks' })
    expect(revision()).toBe(initial + 2)
    navigation.back()
    expect(revision()).toBe(initial + 3)
    navigation.forward()
    expect(revision()).toBe(initial + 4)
  })

  it('boundary back/forward no-ops leave the navigation revision alone', () => {
    const navigation = createNavigationService()
    const revision = (): number => navigation.navigationRevision()
    navigation.navigate({ kind: 'tasks' })
    const settled = revision()

    // Nothing ahead: a stray ⌘] must not cancel a pending link fallback.
    navigation.forward()
    expect(revision()).toBe(settled)

    navigation.back()
    expect(revision()).toBe(settled + 1)
    // Nothing behind either — same rule for ⌘[ at the history start.
    navigation.back()
    expect(revision()).toBe(settled + 1)
  })

  it('restores a saved scroll offset on back/forward, per entry', () => {
    const navigation = createNavigationService()
    navigation.saveScrollState(120) // scrolling on today
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    expect(navigation.savedScroll()).toBeNull() // fresh entry: no offset yet

    navigation.saveScrollState(40)
    navigation.back()
    expect(navigation.savedScroll()).toBe(120) // today's offset restored

    navigation.forward()
    expect(navigation.savedScroll()).toBe(40) // the note's own offset
  })

  it('can clear the active entry scroll offset without changing routes', () => {
    const navigation = createNavigationService()
    const entryId = navigation.getState().entryId
    const arrivals = navigation.getState().arrivalSeq
    navigation.saveScrollState(120)

    navigation.clearScrollState()

    expect(navigation.getState().route).toEqual({ kind: 'today' })
    expect(navigation.getState().entryId).toBe(entryId)
    expect(navigation.getState().arrivalSeq).toBe(arrivals)
    expect(navigation.savedScroll()).toBeNull()
  })

  it('re-navigating to the current route clears its saved scroll (re-anchor intent)', () => {
    const navigation = createNavigationService()
    const seqBefore = navigation.getState().arrivalSeq
    navigation.saveScrollState(500) // user scrolled away on today
    navigation.navigate({ kind: 'today' }) // ⌘D while on today
    expect(navigation.savedScroll()).toBeNull() // re-anchor, don't restore
    expect(navigation.getState().arrivalSeq).toBe(seqBefore + 1) // views are notified
  })

  it('can restore the daily surface scroll when a tab switch returns to today', () => {
    const navigation = createNavigationService()
    navigation.saveScrollState(500) // user scrolled the daily stream
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    navigation.navigate({ kind: 'today' }, { restoreSurfaceScroll: true })

    expect(navigation.getState().route).toEqual({ kind: 'today' })
    expect(navigation.savedScroll()).toBe(500)
  })

  it('keeps default fresh navigations to daily routes anchor-only', () => {
    const navigation = createNavigationService()
    navigation.saveScrollState(500)
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    navigation.navigate({ kind: 'today' })

    expect(navigation.savedScroll()).toBeNull()
  })

  it('a surface-scroll return from within the surface re-anchors instead', () => {
    const navigation = createNavigationService({
      initialRoute: { kind: 'daily', date: '2026-06-08' },
    })
    navigation.saveScrollState(500) // scrolled the stream on a dated day
    navigation.navigate({ kind: 'today' }, { restoreSurfaceScroll: true })
    expect(navigation.savedScroll()).toBeNull() // Daily tab on-stream = ⌘D re-anchor

    navigation.saveScrollState(300)
    navigation.navigate({ kind: 'today' }, { restoreSurfaceScroll: true })
    expect(navigation.savedScroll()).toBeNull() // same while already on today
  })

  it('an explicit re-anchor arrival drops the daily surface offset too', () => {
    const navigation = createNavigationService()
    navigation.saveScrollState(500) // user scrolled away on today
    navigation.navigate({ kind: 'today' }) // ⌘D re-anchors the stream
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    navigation.navigate({ kind: 'today' }, { restoreSurfaceScroll: true })

    expect(navigation.savedScroll()).toBeNull() // the tab can't resurrect pre-⌘D scroll
  })

  it('clearScrollState drops the daily surface offset too (new-note interaction)', () => {
    const navigation = createNavigationService()
    navigation.saveScrollState(500) // scrolled the stream before ⌘N
    navigation.clearScrollState() // note.new discards the stream offsets
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })

    navigation.back()
    expect(navigation.savedScroll()).toBeNull() // ⌘[ re-anchors to today

    navigation.saveScrollState(120) // post-clear scrolling
    navigation.forward()
    navigation.navigate({ kind: 'today' }, { restoreSurfaceScroll: true })
    expect(navigation.savedScroll()).toBe(120) // the tab restores only the new offset
  })

  it('carries the focusEditor intent on the arrival that asked for it, one-shot', () => {
    const navigation = createNavigationService()
    expect(navigation.getState().arrivalFocusEditor).toBe(false)

    navigation.navigate({ kind: 'note', path: 'notes/a.md' }, { focusEditor: true })
    expect(navigation.getState().arrivalFocusEditor).toBe(true)

    // The next arrival overwrites the intent — it can never leak onto a
    // later, unrelated visit (the staleness class a keyed request store had).
    navigation.navigate({ kind: 'note', path: 'notes/b.md' })
    expect(navigation.getState().arrivalFocusEditor).toBe(false)
  })

  it('clears the focusEditor intent on history moves', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' }, { focusEditor: true })
    navigation.back()
    expect(navigation.getState().arrivalFocusEditor).toBe(false)

    navigation.forward()
    expect(navigation.getState().route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(navigation.getState().arrivalFocusEditor).toBe(false)
  })

  it('entryId is stable per entry and changes across back/forward', () => {
    const navigation = createNavigationService()
    const todayId = navigation.getState().entryId
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    const noteId = navigation.getState().entryId
    expect(noteId).not.toBe(todayId)
    navigation.back()
    expect(navigation.getState().entryId).toBe(todayId)
    navigation.forward()
    expect(navigation.getState().entryId).toBe(noteId)
  })

  it('exposes the route back() would land on (the mobile stack peeks it)', () => {
    const navigation = createNavigationService()
    expect(navigation.getState().backRoute).toBeNull()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    expect(navigation.getState().backRoute).toEqual({ kind: 'today' })
    navigation.navigate({ kind: 'note', path: 'notes/b.md' })
    expect(navigation.getState().backRoute).toEqual({ kind: 'note', path: 'notes/a.md' })
    navigation.back()
    expect(navigation.getState().backRoute).toEqual({ kind: 'today' })
    navigation.back()
    expect(navigation.getState().backRoute).toBeNull()
  })

  it('normalizes a malformed daily date to the today route on navigate', () => {
    const navigation = createNavigationService()
    // 2026-02-31 is well-formed but impossible — dailyPath would throw on it.
    navigation.navigate({ kind: 'daily', date: '2026-02-31' })
    expect(navigation.getState().route).toEqual({ kind: 'today' })
    // Normalization happens before the no-op check: re-navigating doesn't push.
    expect(navigation.getState().canBack).toBe(false)
  })

  it('normalizes a malformed daily initial route to today', () => {
    const navigation = createNavigationService({
      initialRoute: { kind: 'daily', date: 'not-a-date' },
    })
    expect(navigation.getState().route).toEqual({ kind: 'today' })
  })

  it('keeps a real daily date intact', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })
    expect(navigation.getState().route).toEqual({ kind: 'daily', date: '2026-06-08' })
  })

  it('drops scroll offsets for a truncated forward branch', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    navigation.saveScrollState(99)
    navigation.back()
    // Navigating from a back position truncates the branch holding notes/a.md.
    navigation.navigate({ kind: 'search', query: 'x' })
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    expect(navigation.savedScroll()).toBeNull() // a new entry, not the old one
  })

  describe('note moves (Plan 17)', () => {
    it('rewrites the current route and history entries when a note moves', () => {
      const navigation = createNavigationService()
      navigation.navigate({ kind: 'note', path: 'notes/01abc.md' })
      navigation.navigate({ kind: 'allNotes', tag: null })
      navigation.navigate({ kind: 'note', path: 'notes/01abc.md' })
      const arrivalsBefore = navigation.getState().arrivalSeq
      const entryBefore = navigation.getState().entryId
      const revisionBefore = navigation.navigationRevision()

      navigation.noteMoved('notes/01abc.md', 'notes/meeting-notes.md')

      // The current entry followed the file — a rewrite, not an arrival, on
      // the same entry (views keep their scroll; nothing re-anchors).
      expect(navigation.getState().route).toEqual({ kind: 'note', path: 'notes/meeting-notes.md' })
      expect(navigation.getState().arrivalSeq).toBe(arrivalsBefore)
      expect(navigation.getState().entryId).toBe(entryBefore)
      expect(navigation.navigationRevision()).toBe(revisionBefore + 1)

      // The earlier history entry followed too: back over the rename lands
      // on the file's real home, never the dead path.
      navigation.back()
      expect(navigation.getState().route).toEqual({ kind: 'allNotes', tag: null })
      navigation.back()
      expect(navigation.getState().route).toEqual({ kind: 'note', path: 'notes/meeting-notes.md' })
    })

    it('leaves unrelated routes untouched', () => {
      const navigation = createNavigationService()
      navigation.navigate({ kind: 'note', path: 'notes/other.md' })

      navigation.noteMoved('notes/01abc.md', 'notes/meeting-notes.md')

      expect(navigation.getState().route).toEqual({ kind: 'note', path: 'notes/other.md' })
    })
  })

  describe('subscriptions', () => {
    it('notifies on every state change and replaces the snapshot', () => {
      const navigation = createNavigationService()
      const seen: string[] = []
      const unsubscribe = navigation.subscribe(() => {
        seen.push(navigation.getState().route.kind)
      })
      const initial = navigation.getState()

      navigation.navigate({ kind: 'tasks' })
      navigation.navigate({ kind: 'tasks' }) // a same-route arrival still bumps arrivalSeq
      navigation.back()
      navigation.forward()
      expect(seen).toEqual(['tasks', 'tasks', 'today', 'tasks'])
      expect(navigation.getState()).not.toBe(initial)

      unsubscribe()
      navigation.back()
      expect(seen).toHaveLength(4)
    })

    it('keeps the snapshot and stays quiet when nothing changes', () => {
      const navigation = createNavigationService()
      let notified = 0
      navigation.subscribe(() => {
        notified += 1
      })
      const initial = navigation.getState()

      navigation.back() // history boundaries
      navigation.forward()
      navigation.saveScrollState(120) // scroll bookkeeping never notifies
      navigation.clearScrollState()
      navigation.noteMoved('notes/absent.md', 'notes/elsewhere.md')

      expect(notified).toBe(0)
      expect(navigation.getState()).toBe(initial)
    })
  })

  it('keeps scroll bookkeeping on the position a view passes', () => {
    const navigation = createNavigationService()
    const today = navigation.getState()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })

    // A view still showing today (its transition is pending) reports a scroll.
    navigation.saveScrollState(120, today)
    expect(navigation.savedScroll()).toBeNull()
    expect(navigation.savedScroll(today)).toBe(120)

    navigation.clearScrollState(today)
    navigation.back()
    expect(navigation.savedScroll()).toBeNull()
  })

  describe('reset', () => {
    it('starts a fresh history on the given route', () => {
      const navigation = createNavigationService()
      navigation.saveScrollState(500)
      navigation.navigate({ kind: 'note', path: 'notes/a.md' }, { focusEditor: true })
      navigation.saveScrollState(40)

      navigation.reset({ kind: 'tasks' })

      expect(navigation.getState()).toEqual({
        route: { kind: 'tasks' },
        entryId: 0,
        arrivalSeq: 0,
        arrivalFocusEditor: false,
        canBack: false,
        canForward: false,
        backRoute: null,
      })
      expect(navigation.savedScroll()).toBeNull()
      // The old history's daily surface offset is gone too.
      navigation.navigate({ kind: 'today' }, { restoreSurfaceScroll: true })
      expect(navigation.savedScroll()).toBeNull()
    })

    it('defaults to today and normalizes a malformed daily route', () => {
      const navigation = createNavigationService({ initialRoute: { kind: 'tasks' } })
      navigation.reset()
      expect(navigation.getState().route).toEqual({ kind: 'today' })
      navigation.reset({ kind: 'daily', date: 'not-a-date' })
      expect(navigation.getState().route).toEqual({ kind: 'today' })
    })

    it('advances the navigation revision without notifying subscribers', () => {
      const navigation = createNavigationService()
      let notified = 0
      navigation.subscribe(() => {
        notified += 1
      })
      const revision = navigation.navigationRevision()

      navigation.reset()

      expect(navigation.navigationRevision()).toBe(revision + 1)
      expect(notified).toBe(0)
    })
  })
})
