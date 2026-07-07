import { describe, expect, it } from 'vitest'
import { tabRootFor } from './mobile-tab-bar'

describe('tabRootFor', () => {
  it('maps tab roots and leaves stacked screens tabless', () => {
    expect(tabRootFor({ kind: 'today' })).toBe('daily')
    expect(tabRootFor({ kind: 'daily', date: '2026-07-07' })).toBe('daily')
    expect(tabRootFor({ kind: 'allNotes', tag: null })).toBe('all')
    expect(tabRootFor({ kind: 'search', query: 'x' })).toBe('all')
    expect(tabRootFor({ kind: 'tasks' })).toBe('tasks')
    expect(tabRootFor({ kind: 'chat' })).toBe('chat')
    expect(tabRootFor({ kind: 'note', path: 'notes/a.md' })).toBeNull()
    expect(tabRootFor({ kind: 'settings' })).toBeNull()
  })
})
