import { describe, expect, it } from 'vitest'
import { contextSidebarTarget } from './sidebar-route'

const TODAY = '2026-06-09'

describe('contextSidebarTarget', () => {
  it('follows the live clock on the today route', () => {
    expect(contextSidebarTarget({ kind: 'today' }, TODAY)).toEqual({
      kind: 'daily',
      date: TODAY,
    })
  })

  it('uses the route date on valid daily routes', () => {
    expect(contextSidebarTarget({ kind: 'daily', date: '2026-06-01' }, TODAY)).toEqual({
      kind: 'daily',
      date: '2026-06-01',
    })
  })

  it('trusts the daily date — the router normalizes malformed ones away', () => {
    // normalizeRoute (routing/route.ts) collapses an impossible daily date to
    // the today route before it can reach a view; see router.test.tsx.
    expect(contextSidebarTarget({ kind: 'daily', date: '2026-06-15' }, TODAY)).toEqual({
      kind: 'daily',
      date: '2026-06-15',
    })
  })

  it('targets the open note on note routes', () => {
    expect(contextSidebarTarget({ kind: 'note', path: 'notes/a.md' }, TODAY)).toEqual({
      kind: 'note',
      path: 'notes/a.md',
    })
  })

  it('shows no context sidebar on search and settings routes', () => {
    expect(contextSidebarTarget({ kind: 'search', query: 'rust' }, TODAY)).toBeNull()
    expect(contextSidebarTarget({ kind: 'settings' }, TODAY)).toBeNull()
  })
})
