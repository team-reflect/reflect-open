import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createTestCoreServices } from '@reflect/core/testing'
import { useGraph, useMaybeGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useGitSyncContext } from '@/providers/sync-provider.tsx'
import { useRouter } from '@/routing/router.tsx'
import { useGraphServices } from '@/services/services-provider.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { MOBILE_PLATFORM, renderHookInApp, renderInApp } from './render-in-app.tsx'

function Probe(): ReactElement {
  const { status, graph, indexGeneration, indexing, recents, mobileStorageKind } = useGraph()
  const { settings, updateSettings } = useSettings()
  const { route, navigate } = useRouter()
  const sync = useGitSyncContext()
  return (
    <div>
      <output data-testid="graph">
        {status} {graph?.root ?? 'none'} {graph?.generation ?? '-'} {indexGeneration ?? '-'}{' '}
        {indexing ? 'indexing' : 'idle'} {recents.length} {mobileStorageKind ?? '-'}
      </output>
      <output data-testid="settings">{settings.dateFormat}</output>
      <output data-testid="route">{JSON.stringify(route)}</output>
      <output data-testid="git-sync">{sync?.state.phase ?? 'no sync'}</output>
      <button type="button" onClick={() => updateSettings({ dateFormat: 'iso' })}>
        iso
      </button>
      <button type="button" onClick={() => navigate({ kind: 'tasks' })}>
        tasks
      </button>
    </div>
  )
}

function SessionRoot(): ReactElement {
  return <output data-testid="session">{useGraphServices().session.root}</output>
}

describe('renderInApp', () => {
  it('opens the default test graph over the real providers', async () => {
    await renderInApp(
      <>
        <Probe />
        <SessionRoot />
      </>,
    )

    await expect
      .element(page.getByTestId('graph'))
      .toHaveTextContent('ready /graphs/test 1 1 idle 0 -')
    await expect.element(page.getByTestId('session')).toHaveTextContent('/graphs/test')
    await expect.element(page.getByTestId('route')).toHaveTextContent('{"kind":"today"}')
    await expect.element(page.getByTestId('git-sync')).toHaveTextContent('disconnected')
  })

  it('reports the graph, the graph state and a later graph switch', async () => {
    const { core } = await renderInApp(<Probe />, {
      graph: { root: '/g', generation: 3, indexGeneration: 7 },
      graphState: { indexing: true, recents: [{ root: '/g', name: 'g', openedMs: 1 }] },
    })
    await expect.element(page.getByTestId('graph')).toHaveTextContent('ready /g 3 7 indexing 1 -')

    core.graphSession.setGraph(null)
    await expect.element(page.getByTestId('graph')).toHaveTextContent('choosing none - - idle 1 -')
  })

  it('shows the stored settings on the first render and saves updates', async () => {
    const { core } = await renderInApp(<Probe />, { settings: { dateFormat: 'dmy' } })
    expect(page.getByTestId('settings').element().textContent).toBe('dmy')

    await page.getByRole('button', { name: 'iso' }).click()

    await expect.element(page.getByTestId('settings')).toHaveTextContent('iso')
    await vi.waitFor(() => expect(core.settings.saves().at(-1)?.dateFormat).toBe('iso'))
  })

  it('starts on the given route and records navigation in the navigation service', async () => {
    const { appServices } = await renderInApp(<Probe />, { route: { kind: 'settings' } })
    await expect.element(page.getByTestId('route')).toHaveTextContent('{"kind":"settings"}')

    await page.getByRole('button', { name: 'tasks' }).click()

    await expect.element(page.getByTestId('route')).toHaveTextContent('{"kind":"tasks"}')
    expect(appServices.navigation.navigations()).toEqual([
      { route: { kind: 'tasks' }, options: undefined },
    ])
  })

  it('runs a scripted backup for the open graph', async () => {
    const { gitSync } = await renderInApp(<Probe />, { sync: { phase: 'disconnected' } })
    await expect.element(page.getByTestId('git-sync')).toHaveTextContent('disconnected')

    gitSync?.setState({ phase: 'loading' })
    await expect.element(page.getByTestId('git-sync')).toHaveTextContent('loading')
  })

  it('renders the mobile surface with the mobile onboarding state', async () => {
    const { core } = await renderInApp(<Probe />, {
      platform: MOBILE_PLATFORM,
      mobile: { kind: 'icloud' },
    })

    await expect
      .element(page.getByTestId('graph'))
      .toHaveTextContent('ready /graphs/test 1 1 idle 0 icloud')
    expect(core.platform.surface.mobileApp).toBe(true)
  })

  it('uses the given core services, so a test can spy on a service before the first render', async () => {
    const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
    const view = await renderInApp(<Probe />, { core })

    expect(view.core).toBe(core)
    await expect(renderInApp(<Probe />, { core, platform: MOBILE_PLATFORM })).rejects.toThrow(
      /with your own `core`/,
    )
  })

  it('mounts only the services with `servicesOnly`, and registers the app commands', async () => {
    const { result, appServices: appLayer } = await renderHookInApp(() => useMaybeGraph(), {
      servicesOnly: true,
    })

    expect(result.current).toBeNull()
    expect(appLayer.commands.list().map((command) => command.id)).toContain('nav.today')
  })
})

describe('renderHookInApp', () => {
  it('runs the hook inside the same providers', async () => {
    const { result, core } = await renderHookInApp(() => useGraph().graph?.root ?? null, {
      graph: { root: '/g' },
    })
    expect(result.current).toBe('/g')

    core.graphSession.setGraph({ root: '/other' })
    await vi.waitFor(() => expect(result.current).toBe('/other'))
  })
})
