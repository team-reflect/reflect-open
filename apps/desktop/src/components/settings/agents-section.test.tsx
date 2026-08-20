import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge, type AgentSkillStatus } from '@reflect/core'
import { queryKeys } from '@/lib/query-client'
import { AgentsSection } from './agents-section'

// A browser-mode module mock materializes value exports once, so this file
// keeps the flag statically true; the off-macOS test lives in
// `agents-section-non-macos.test.tsx`.
vi.mock('@/lib/platform', () => ({ isMacosDesktop: true, isNativeShell: () => true }))

const GRAPH = { root: '/graphs/Personal', name: 'Personal', generation: 7 }
const graphState = vi.hoisted(() => ({
  graph: { root: '/graphs/Personal', name: 'Personal', generation: 7 },
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => graphState,
}))

type InstallState = 'missing' | 'current' | 'stale' | 'conflict'

let installState: InstallState
let installGenerations: number[]
let uninstallGenerations: number[]
let installResult: () => Promise<AgentSkillStatus>
let uninstallResult: () => Promise<AgentSkillStatus>
let queryClient: QueryClient

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise = (_value: T): void => {
    throw new Error('promise not initialized')
  }
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: (value) => resolvePromise(value) }
}

function statusPayload(): AgentSkillStatus {
  return {
    skillName: 'reflect-personal',
    skillPath: '/Users/me/.agents/skills/reflect-personal/SKILL.md',
    cliPath: '/Applications/Reflect.app/Contents/MacOS/reflect',
    installState,
  }
}

function installFakeBridge(): void {
  installGenerations = []
  uninstallGenerations = []
  setBridge({
    invoke: async (command, args) => {
      switch (command) {
        case 'skill_status':
          return statusPayload()
        case 'skill_install': {
          const generation = args?.['generation']
          if (typeof generation !== 'number') {
            throw new Error('missing generation')
          }
          installGenerations.push(generation)
          return await installResult()
        }
        case 'skill_uninstall': {
          const generation = args?.['generation']
          if (typeof generation !== 'number') {
            throw new Error('missing generation')
          }
          uninstallGenerations.push(generation)
          return await uninstallResult()
        }
        default:
          throw new Error(`unexpected command ${command}`)
      }
    },
    listen: async () => () => {},
  })
}

type SectionView = Awaited<ReturnType<typeof render>>

async function renderSection(): Promise<SectionView> {
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentsSection />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  graphState.graph = GRAPH
  installState = 'missing'
  installResult = async () => {
    installState = 'current'
    return statusPayload()
  }
  uninstallResult = async () => {
    installState = 'missing'
    return statusPayload()
  }
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  installFakeBridge()
})

afterEach(() => {
  setBridge(null)
  queryClient.clear()
})

describe('AgentsSection', () => {
  it('installs the skill with the graph generation pinned', async () => {
    await renderSection()
    await page.getByRole('button', { name: 'Install skill' }).click()

    await expect.element(page.getByText('Installed')).toBeInTheDocument()
    expect(installGenerations).toEqual([GRAPH.generation])
    await expect
      .element(page.getByText('/Users/me/.agents/skills/reflect-personal/SKILL.md'))
      .toBeInTheDocument()
  })

  it('updates a stale install with the graph generation pinned', async () => {
    installState = 'stale'
    await renderSection()

    await page.getByRole('button', { name: 'Update skill' }).click()
    await expect.element(page.getByText('Installed')).toBeInTheDocument()
    expect(installGenerations).toEqual([GRAPH.generation])
  })

  it('removes any managed install with the graph generation pinned', async () => {
    installState = 'stale'
    await renderSection()

    await page.getByRole('button', { name: 'Remove' }).click()
    await expect.element(page.getByRole('button', { name: 'Install skill' })).toBeInTheDocument()
    expect(uninstallGenerations).toEqual([GRAPH.generation])
  })

  it('disables all actions while one mutation is pending', async () => {
    installState = 'stale'
    installResult = () => new Promise<AgentSkillStatus>(() => {})
    await renderSection()

    await page.getByRole('button', { name: 'Update skill' }).click()
    await expect.element(page.getByRole('button', { name: 'Update skill' })).toBeDisabled()
    await expect.element(page.getByRole('button', { name: 'Remove' })).toBeDisabled()
  })

  it('shows mutation errors and clears them when retrying', async () => {
    let shouldFail = true
    installResult = async () => {
      if (shouldFail) {
        throw new Error('Installing failed')
      }
      installState = 'current'
      return statusPayload()
    }
    await renderSection()

    await page.getByRole('button', { name: 'Install skill' }).click()
    await expect.element(page.getByText('Installing failed')).toBeInTheDocument()

    shouldFail = false
    await page.getByRole('button', { name: 'Install skill' }).click()
    await expect.element(page.getByText('Installed')).toBeInTheDocument()
    expect(page.getByText('Installing failed').query()).toBeNull()
  })

  it('writes a completed mutation to its original graph cache', async () => {
    const pendingInstall = deferred<AgentSkillStatus>()
    installResult = () => pendingInstall.promise
    const view = await renderSection()
    await page.getByRole('button', { name: 'Install skill' }).click()

    const nextGraph = { root: '/graphs/Work', name: 'Work', generation: 11 }
    graphState.graph = nextGraph
    await view.rerender(
      <QueryClientProvider client={queryClient}>
        <AgentsSection />
      </QueryClientProvider>,
    )
    const nextStatus = { ...statusPayload(), skillPath: '/work/SKILL.md' }
    queryClient.setQueryData(queryKeys.agentSkill.status(nextGraph.root), nextStatus)

    installState = 'current'
    pendingInstall.resolve(statusPayload())
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.agentSkill.status(GRAPH.root))).toEqual(
        statusPayload(),
      ),
    )
    expect(queryClient.getQueryData(queryKeys.agentSkill.status(nextGraph.root))).toEqual(
      nextStatus,
    )
  })

  it('refuses to touch an unmanaged file', async () => {
    installState = 'conflict'
    await renderSection()

    await expect.element(page.getByText(/Reflect doesn’t manage/)).toBeInTheDocument()
    expect(page.getByRole('button', { name: 'Install skill' }).query()).toBeNull()
    expect(page.getByRole('button', { name: 'Remove' }).query()).toBeNull()
  })
})
