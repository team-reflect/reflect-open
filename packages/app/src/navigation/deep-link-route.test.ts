import { describe, expect, it } from 'vitest'
import { initialRouteForDeepLink, routeForDeepLinkTarget } from './deep-link-route.ts'

describe('initialRouteForDeepLink', () => {
  it('derives navigate links directly', () => {
    expect(initialRouteForDeepLink('reflect://daily/2026-07-05')).toEqual({
      kind: 'daily',
      date: '2026-07-05',
    })
    expect(initialRouteForDeepLink('reflect://today')).toEqual({ kind: 'today' })
  })

  it('derives path-shaped note targets without the index', () => {
    // ⌘-click builds these via deepLinkForRoute, so the target IS the path.
    expect(initialRouteForDeepLink('reflect://note/notes%2Ffoo.md')).toEqual({
      kind: 'note',
      path: 'notes/foo.md',
    })
    // A daily path routes to the daily view, same as routeForPath everywhere.
    expect(initialRouteForDeepLink('reflect://note/daily%2F2026-07-04.md')).toEqual({
      kind: 'daily',
      date: '2026-07-04',
    })
  })

  it('declines targets only the index can answer', () => {
    expect(initialRouteForDeepLink('reflect://note/Meeting%20Notes')).toBeNull()
    expect(initialRouteForDeepLink('reflect://note/01hzx4abc')).toBeNull()
  })

  it('declines capture links, garbage, and absence', () => {
    expect(initialRouteForDeepLink('reflect://append?text=hi')).toBeNull()
    expect(initialRouteForDeepLink('not a url')).toBeNull()
    expect(initialRouteForDeepLink(null)).toBeNull()
  })
})

describe('routeForDeepLinkTarget', () => {
  it('routes places and notes, and nothing else', () => {
    expect(routeForDeepLinkTarget({ kind: 'search', query: 'q' })).toEqual({
      kind: 'search',
      query: 'q',
    })
    expect(routeForDeepLinkTarget({ kind: 'note', path: 'daily/2026-07-01.md' })).toEqual({
      kind: 'daily',
      date: '2026-07-01',
    })
    expect(routeForDeepLinkTarget({ kind: 'capture' })).toBeNull()
    expect(routeForDeepLinkTarget({ kind: 'none' })).toBeNull()
  })
})
