import {
  createTestCoreServices,
  createTestPlatformService,
  createTestStorageService,
} from '@reflect/core/testing'
import type { Route, Section } from '@reflect/app'
import { describe, expect, it } from 'vitest'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useRestoredRoute } from './use-restored-route.ts'

const STORAGE_KEY = 'reflect.mobile.route'

/** Renders the hook for the graph `/graph`, with `stored` in session storage. */
async function renderRestoredRoute(stored: unknown, isSwiftMobile = true) {
  const storage = createTestStorageService()
  storage.session.set(STORAGE_KEY, JSON.stringify(stored))
  const core = createTestCoreServices({
    storage,
    database: createWasmTestDatabaseService(),
    platform: createTestPlatformService({ isSwiftMobile }),
  })
  const view = await renderHookInApp(() => useRestoredRoute('/graph'), { core })
  return { view, storage }
}

function storedRoute(
  graphRoot: string,
  route: Route | { kind: 'nowhere' },
  section: Section = 'tasks',
): unknown {
  return { graphRoot, route, section }
}

describe('useRestoredRoute', () => {
  it('returns the route stored for the graph and removes it', async () => {
    const note: Route = { kind: 'note', path: 'a.md' }
    const { view, storage } = await renderRestoredRoute(storedRoute('/graph', note))
    expect(view.result.current).toEqual({ route: note, section: 'tasks' })
    expect(storage.session.get(STORAGE_KEY)).toBeNull()
  })

  it('ignores a route stored for another graph', async () => {
    const { view } = await renderRestoredRoute(storedRoute('/other', { kind: 'tasks' }))
    expect(view.result.current).toBeUndefined()
  })

  it('ignores a stored value that is not a route', async () => {
    const { view } = await renderRestoredRoute(storedRoute('/graph', { kind: 'nowhere' }))
    expect(view.result.current).toBeUndefined()
  })

  it('stores the route of each navigation', async () => {
    const { view, storage } = await renderRestoredRoute(null)
    view.appServices.navigation.navigate({ kind: 'tasks' })
    expect(storage.session.get(STORAGE_KEY)).toBe(
      JSON.stringify(storedRoute('/graph', { kind: 'tasks' })),
    )
  })

  it('does nothing outside the Swift shell', async () => {
    const stored = storedRoute('/graph', { kind: 'tasks' })
    const { view, storage } = await renderRestoredRoute(stored, false)
    expect(view.result.current).toBeUndefined()
    view.appServices.navigation.navigate({ kind: 'settings', page: 'main' })
    expect(storage.session.get(STORAGE_KEY)).toBe(JSON.stringify(stored))
  })
})
