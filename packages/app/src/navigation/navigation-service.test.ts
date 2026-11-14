import { describe, expect, it } from 'vitest'
import { createNavigationService } from './navigation-service.ts'

describe('NavigationService', () => {
  it('starts on today with no history', () => {
    const navigation = createNavigationService()
    expect(navigation.get().route).toEqual({ kind: 'today' })
    expect(navigation.get().canBack).toBe(false)
    expect(navigation.get().canForward).toBe(false)
  })

  it('navigate pushes; back and forward traverse the stack', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    expect(navigation.get().route).toEqual({ kind: 'note', path: 'notes/a.md' })

    navigation.back()
    expect(navigation.get().route).toEqual({ kind: 'daily', date: '2026-06-08' })
    expect(navigation.get().canForward).toBe(true)

    navigation.forward()
    expect(navigation.get().route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(navigation.get().canForward).toBe(false)
  })

  it('navigating from a back position truncates the forward branch', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })
    navigation.navigate({ kind: 'daily', date: '2026-06-07' })
    navigation.back()
    navigation.navigate({ kind: 'search', query: 'x' })
    expect(navigation.get().canForward).toBe(false)
    navigation.back()
    expect(navigation.get().route).toEqual({ kind: 'daily', date: '2026-06-08' })
  })

  it('replace swaps the current entry and keeps forward entries', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'tasks' })
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    navigation.back()
    const before = navigation.get().entryId
    navigation.saveScrollState(40)

    navigation.navigate({ kind: 'daily', date: '2026-06-07' }, { replace: true })
    expect(navigation.get().route).toEqual({ kind: 'daily', date: '2026-06-07' })
    expect(navigation.get().entryId).not.toBe(before)
    expect(navigation.savedScroll()).toBeNull()
    expect(navigation.get().canForward).toBe(true)

    navigation.back()
    expect(navigation.get().route).toEqual({ kind: 'tasks' })
    navigation.forward()
    navigation.forward()
    expect(navigation.get().route).toEqual({ kind: 'note', path: 'notes/a.md' })
  })

  it('replace onto a neighbor that shows the target merges into it', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'daily', date: '2026-06-07' })
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })

    navigation.navigate({ kind: 'daily', date: '2026-06-07' }, { replace: true })
    navigation.back()
    expect(navigation.get().route).toEqual({ kind: 'today' })
    expect(navigation.get().canBack).toBe(false)

    navigation.navigate({ kind: 'daily', date: '2026-06-09' })
    navigation.back()
    navigation.navigate({ kind: 'daily', date: '2026-06-09' }, { replace: true })
    expect(navigation.get().route).toEqual({ kind: 'daily', date: '2026-06-09' })
    expect(navigation.get().canForward).toBe(false)
    expect(navigation.get().canBack).toBe(false)

    // Both neighbors show the target: the entry and the forward copy go.
    navigation.navigate({ kind: 'daily', date: '2026-06-07' })
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })
    navigation.navigate({ kind: 'daily', date: '2026-06-07' })
    navigation.back()
    navigation.navigate({ kind: 'daily', date: '2026-06-07' }, { replace: true })
    expect(navigation.get().route).toEqual({ kind: 'daily', date: '2026-06-07' })
    expect(navigation.get().canForward).toBe(false)
    navigation.back()
    expect(navigation.get().route).toEqual({ kind: 'daily', date: '2026-06-09' })
  })

  it('re-navigating to the current route is a no-op (no stack growth)', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })
    navigation.back()
    expect(navigation.get().route).toEqual({ kind: 'today' })
    expect(navigation.get().canBack).toBe(false)
  })

  it('back/forward at the edges are no-ops', () => {
    const navigation = createNavigationService()
    navigation.back()
    expect(navigation.get().route).toEqual({ kind: 'today' })
    navigation.forward()
    expect(navigation.get().route).toEqual({ kind: 'today' })
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
    const entryId = navigation.get().entryId
    const arrivals = navigation.get().arrivalSeq
    navigation.saveScrollState(120)

    navigation.clearScrollState()

    expect(navigation.get().route).toEqual({ kind: 'today' })
    expect(navigation.get().entryId).toBe(entryId)
    expect(navigation.get().arrivalSeq).toBe(arrivals)
    expect(navigation.savedScroll()).toBeNull()
  })

  it('re-navigating to the current route clears its saved scroll (re-anchor intent)', () => {
    const navigation = createNavigationService()
    const seqBefore = navigation.get().arrivalSeq
    navigation.saveScrollState(500) // user scrolled away on today
    navigation.navigate({ kind: 'today' }) // ⌘D while on today
    expect(navigation.savedScroll()).toBeNull() // re-anchor, don't restore
    expect(navigation.get().arrivalSeq).toBe(seqBefore + 1) // views are notified
  })

  it('can restore the daily surface scroll when a tab switch returns to today', () => {
    const navigation = createNavigationService()
    navigation.saveScrollState(500) // user scrolled the daily stream
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    navigation.selectSection('daily')

    expect(navigation.get().route).toEqual({ kind: 'today' })
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
    navigation.selectSection('daily')
    expect(navigation.savedScroll()).toBeNull() // Daily tab on-stream = ⌘D re-anchor

    navigation.saveScrollState(300)
    navigation.selectSection('daily')
    expect(navigation.savedScroll()).toBeNull() // same while already on today
  })

  it('an explicit re-anchor arrival drops the daily surface offset too', () => {
    const navigation = createNavigationService()
    navigation.saveScrollState(500) // user scrolled away on today
    navigation.navigate({ kind: 'today' }) // ⌘D re-anchors the stream
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    navigation.selectSection('daily')

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
    navigation.selectSection('daily')
    expect(navigation.savedScroll()).toBe(120) // the tab restores only the new offset
  })

  it('carries the focusEditor intent on the arrival that asked for it, one-shot', () => {
    const navigation = createNavigationService()
    expect(navigation.get().arrivalFocusEditor).toBe(false)

    navigation.navigate({ kind: 'note', path: 'notes/a.md' }, { focusEditor: true })
    expect(navigation.get().arrivalFocusEditor).toBe(true)

    // The next arrival overwrites the intent — it can never leak onto a
    // later, unrelated visit (the staleness class a keyed request store had).
    navigation.navigate({ kind: 'note', path: 'notes/b.md' })
    expect(navigation.get().arrivalFocusEditor).toBe(false)
  })

  it('clears the focusEditor intent on history moves', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' }, { focusEditor: true })
    navigation.back()
    expect(navigation.get().arrivalFocusEditor).toBe(false)

    navigation.forward()
    expect(navigation.get().route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(navigation.get().arrivalFocusEditor).toBe(false)
  })

  it('entryId is stable per entry and changes across back/forward', () => {
    const navigation = createNavigationService()
    const todayId = navigation.get().entryId
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    const noteId = navigation.get().entryId
    expect(noteId).not.toBe(todayId)
    navigation.back()
    expect(navigation.get().entryId).toBe(todayId)
    navigation.forward()
    expect(navigation.get().entryId).toBe(noteId)
  })

  it('exposes the route back() would land on (the mobile stack peeks it)', () => {
    const navigation = createNavigationService()
    expect(navigation.get().backRoute).toBeNull()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    expect(navigation.get().backRoute).toEqual({ kind: 'today' })
    navigation.navigate({ kind: 'note', path: 'notes/b.md' })
    expect(navigation.get().backRoute).toEqual({ kind: 'note', path: 'notes/a.md' })
    navigation.back()
    expect(navigation.get().backRoute).toEqual({ kind: 'today' })
    navigation.back()
    expect(navigation.get().backRoute).toBeNull()
  })

  it('normalizes a malformed daily date to the today route on navigate', () => {
    const navigation = createNavigationService()
    // 2026-02-31 is well-formed but impossible — dailyPath would throw on it.
    navigation.navigate({ kind: 'daily', date: '2026-02-31' })
    expect(navigation.get().route).toEqual({ kind: 'today' })
    // Normalization happens before the no-op check: re-navigating doesn't push.
    expect(navigation.get().canBack).toBe(false)
  })

  it('normalizes a malformed daily initial route to today', () => {
    const navigation = createNavigationService({
      initialRoute: { kind: 'daily', date: 'not-a-date' },
    })
    expect(navigation.get().route).toEqual({ kind: 'today' })
  })

  it('keeps a real daily date intact', () => {
    const navigation = createNavigationService()
    navigation.navigate({ kind: 'daily', date: '2026-06-08' })
    expect(navigation.get().route).toEqual({ kind: 'daily', date: '2026-06-08' })
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

  describe('sections', () => {
    it('puts a Chat navigation in the section set for Chat', () => {
      const navigation = createNavigationService()
      navigation.navigate({ kind: 'chat' })
      expect(navigation.get().section).toBe('chat')
      navigation.setChatSection('all')
      navigation.navigate({ kind: 'tasks' })
      navigation.navigate({ kind: 'chat' })
      expect(navigation.get().section).toBe('all')
    })

    it('gives a root its own section and a note the current section', () => {
      const navigation = createNavigationService()
      expect(navigation.get().section).toBe('daily')
      navigation.navigate({ kind: 'tasks' })
      navigation.navigate({ kind: 'note', path: 'notes/a.md' })
      expect(navigation.get().section).toBe('tasks')
      navigation.navigate({ kind: 'chat' }, { section: 'all' })
      expect(navigation.get().section).toBe('all')
      navigation.back()
      expect(navigation.get().section).toBe('tasks')
    })

    it('returns to the screen a section was left on, over its root', () => {
      const navigation = createNavigationService()
      navigation.navigate({ kind: 'tasks' })
      navigation.navigate({ kind: 'note', path: 'notes/a.md' })
      navigation.navigate({ kind: 'today' })

      navigation.selectSection('tasks')

      expect(navigation.get().route).toEqual({ kind: 'note', path: 'notes/a.md' })
      expect(navigation.get().section).toBe('tasks')
      expect(navigation.get().backRoute).toEqual({ kind: 'tasks' })
    })

    it('goes to the default root from within the section, and re-anchors there', () => {
      const navigation = createNavigationService()
      navigation.navigate({ kind: 'allNotes', tag: 'work' })
      navigation.navigate({ kind: 'note', path: 'notes/a.md' })

      navigation.selectSection('all')
      expect(navigation.get().route).toEqual({ kind: 'allNotes', tag: null })

      const arrivals = navigation.get().arrivalSeq
      const entry = navigation.get().entryId
      navigation.selectSection('all', { focusEditor: true })
      expect(navigation.get().entryId).toBe(entry)
      expect(navigation.get().arrivalSeq).toBe(arrivals + 1)
      expect(navigation.get().arrivalFocusEditor).toBe(true)
    })

    it('puts the last root, tag filter included, under the restored screen', () => {
      const navigation = createNavigationService()
      navigation.navigate({ kind: 'allNotes', tag: 'work' })
      navigation.navigate({ kind: 'note', path: 'notes/a.md' })
      navigation.navigate({ kind: 'tasks' })

      navigation.selectSection('all')
      expect(navigation.get().backRoute).toEqual({ kind: 'allNotes', tag: 'work' })
    })

    it('pushes the current route again when a navigation moves it to another section', () => {
      const navigation = createNavigationService()
      navigation.navigate({ kind: 'chat' }, { section: 'all' })
      navigation.navigate({ kind: 'chat' }, { section: 'chat' })
      expect(navigation.get().section).toBe('chat')
      navigation.navigate({ kind: 'chat' })
      expect(navigation.get().section).toBe('chat')
      navigation.back()
      expect(navigation.get().section).toBe('all')
    })

    it('returns Daily to its last day, never to a note opened from it', () => {
      const navigation = createNavigationService()
      navigation.navigate({ kind: 'daily', date: '2026-06-08' })
      navigation.saveScrollState({ date: '2026-06-08', offset: 40 })
      navigation.navigate({ kind: 'note', path: 'notes/a.md' })
      navigation.navigate({ kind: 'tasks' })

      navigation.selectSection('daily')

      expect(navigation.get().route).toEqual({ kind: 'daily', date: '2026-06-08' })
      expect(navigation.savedScroll()).toEqual({ date: '2026-06-08', offset: 40 })
    })

    it('lands on the default root of a section it has not shown', () => {
      const navigation = createNavigationService()
      navigation.selectSection('all')
      expect(navigation.get().route).toEqual({ kind: 'allNotes', tag: null })
      expect(navigation.get().canBack).toBe(true)
    })

    it('follows note moves and forgets deleted notes', () => {
      const navigation = createNavigationService()
      navigation.navigate({ kind: 'tasks' })
      navigation.navigate({ kind: 'note', path: 'notes/a.md' })
      navigation.navigate({ kind: 'today' })

      navigation.noteMoved('notes/a.md', 'notes/b.md')
      navigation.selectSection('tasks')
      expect(navigation.get().route).toEqual({ kind: 'note', path: 'notes/b.md' })

      navigation.navigate({ kind: 'today' })
      navigation.forgetNotes((path) => path === 'notes/b.md')
      navigation.selectSection('tasks')
      expect(navigation.get().route).toEqual({ kind: 'tasks' })
    })
  })

  describe('note moves (Plan 17)', () => {
    it('rewrites the current route and history entries when a note moves', () => {
      const navigation = createNavigationService()
      navigation.navigate({ kind: 'note', path: 'notes/01abc.md' })
      navigation.navigate({ kind: 'allNotes', tag: null })
      navigation.navigate({ kind: 'note', path: 'notes/01abc.md' })
      const arrivalsBefore = navigation.get().arrivalSeq
      const entryBefore = navigation.get().entryId
      const revisionBefore = navigation.navigationRevision()

      navigation.noteMoved('notes/01abc.md', 'notes/meeting-notes.md')

      // The current entry followed the file — a rewrite, not an arrival, on
      // the same entry (views keep their scroll; nothing re-anchors).
      expect(navigation.get().route).toEqual({ kind: 'note', path: 'notes/meeting-notes.md' })
      expect(navigation.get().arrivalSeq).toBe(arrivalsBefore)
      expect(navigation.get().entryId).toBe(entryBefore)
      expect(navigation.navigationRevision()).toBe(revisionBefore + 1)

      // The earlier history entry followed too: back over the rename lands
      // on the file's real home, never the dead path.
      navigation.back()
      expect(navigation.get().route).toEqual({ kind: 'allNotes', tag: null })
      navigation.back()
      expect(navigation.get().route).toEqual({ kind: 'note', path: 'notes/meeting-notes.md' })
    })

    it('leaves unrelated routes untouched', () => {
      const navigation = createNavigationService()
      navigation.navigate({ kind: 'note', path: 'notes/other.md' })

      navigation.noteMoved('notes/01abc.md', 'notes/meeting-notes.md')

      expect(navigation.get().route).toEqual({ kind: 'note', path: 'notes/other.md' })
    })
  })

  describe('subscriptions', () => {
    it('notifies on every state change and replaces the snapshot', () => {
      const navigation = createNavigationService()
      const seen: string[] = []
      const unsubscribe = navigation.subscribe(() => {
        seen.push(navigation.get().route.kind)
      })
      const initial = navigation.get()

      navigation.navigate({ kind: 'tasks' })
      navigation.navigate({ kind: 'tasks' }) // a same-route arrival still bumps arrivalSeq
      navigation.back()
      navigation.forward()
      expect(seen).toEqual(['tasks', 'tasks', 'today', 'tasks'])
      expect(navigation.get()).not.toBe(initial)

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
      const initial = navigation.get()

      navigation.back() // history boundaries
      navigation.forward()
      navigation.saveScrollState(120) // scroll bookkeeping never notifies
      navigation.clearScrollState()
      navigation.noteMoved('notes/absent.md', 'notes/elsewhere.md')

      expect(notified).toBe(0)
      expect(navigation.get()).toBe(initial)
    })
  })

  it('keeps scroll bookkeeping on the position a view passes', () => {
    const navigation = createNavigationService()
    const today = navigation.get()
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

      expect(navigation.get()).toEqual({
        route: { kind: 'tasks' },
        entryId: 0,
        arrivalSeq: 0,
        arrivalFocusEditor: false,
        canBack: false,
        canForward: false,
        backRoute: null,
        section: 'tasks',
      })
      expect(navigation.savedScroll()).toBeNull()
      // The old history's daily surface offset is gone too.
      navigation.selectSection('daily')
      expect(navigation.savedScroll()).toBeNull()
    })

    it('starts in the given section', () => {
      const navigation = createNavigationService()
      navigation.reset({ kind: 'note', path: 'notes/a.md' }, 'tasks')
      expect(navigation.get().section).toBe('tasks')
    })

    it('defaults to today and normalizes a malformed daily route', () => {
      const navigation = createNavigationService({ initialRoute: { kind: 'tasks' } })
      navigation.reset()
      expect(navigation.get().route).toEqual({ kind: 'today' })
      navigation.reset({ kind: 'daily', date: 'not-a-date' })
      expect(navigation.get().route).toEqual({ kind: 'today' })
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
