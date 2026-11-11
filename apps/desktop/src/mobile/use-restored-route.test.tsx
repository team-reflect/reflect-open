import { createTestCoreServices, createTestStorageService } from '@reflect/core/testing'
import type { Route } from '@reflect/app'
import { afterEach, describe, expect, it } from 'vitest'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useRestoredRoute } from './use-restored-route.ts'

const STORAGE_KEY = 'reflect.mobile.route'

/** Renders the hook for the graph `/graph`, with `stored` in session storage. */
async function renderRestoredRoute(stored: unknown, host: 'swift' | 'tauri' = 'swift') {
  if (host === 'swift') {
    window.__reflectHost = { on: () => () => {} }
  }
  const storage = createTestStorageService()
  storage.session.set(STORAGE_KEY, JSON.stringify(stored))
  const core = createTestCoreServices({ storage, database: createWasmTestDatabaseService() })
  const view = await renderHookInApp(() => useRestoredRoute('/graph'), { core })
  return { view, storage }
}

function storedRoute(graphRoot: string, route: Route | { kind: 'nowhere' }): unknown {
  return { graphRoot, route }
}

afterEach(() => {
  delete window.__reflectHost
})

describe('useRestoredRoute', () => {
  it('returns the route stored for the graph and removes it', async () => {
    const { view, storage } = await renderRestoredRoute(storedRoute('/graph', { kind: 'tasks' }))
    expect(view.result.current).toEqual({ kind: 'tasks' })
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
    const { view, storage } = await renderRestoredRoute(stored, 'tauri')
    expect(view.result.current).toBeUndefined()
    view.appServices.navigation.navigate({ kind: 'settings' })
    expect(storage.session.get(STORAGE_KEY)).toBe(JSON.stringify(stored))
  })
})
