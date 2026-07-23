import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { AgentsSection } from './agents-section'

// A browser-mode module mock materializes value exports once, so this file
// keeps the flag statically true; the off-macOS test lives in
// `agents-section-non-macos.test.tsx`.
vi.mock('@/lib/platform', () => ({ isMacosDesktop: true }))

const GRAPH = { root: '/graphs/Personal', name: 'Personal', generation: 7 }
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: GRAPH }),
}))

type InstallState = 'missing' | 'current' | 'stale' | 'conflict'

let installState: InstallState
let installCalls: Array<Record<string, unknown>>
let uninstallCalls: Array<Record<string, unknown>>

function statusPayload(): Record<string, unknown> {
  return {
    skillName: 'reflect-personal',
    skillPath: '/Users/me/.agents/skills/reflect-personal/SKILL.md',
    cliPath: '/Applications/Reflect.app/Contents/MacOS/reflect',
    installState,
  }
}

function installFakeBridge(): void {
  installCalls = []
  uninstallCalls = []
  setBridge({
    invoke: async (command, args) => {
      switch (command) {
        case 'skill_status':
          return statusPayload()
        case 'skill_install': {
          installCalls.push(args ?? {})
          installState = 'current'
          return statusPayload()
        }
        case 'skill_uninstall': {
          uninstallCalls.push(args ?? {})
          installState = 'missing'
          return statusPayload()
        }
        default:
          throw new Error(`unexpected command ${command}`)
      }
    },
    listen: async () => () => {},
  })
}

async function renderSection(): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await render(
    <QueryClientProvider client={queryClient}>
      <AgentsSection />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  installState = 'missing'
  installFakeBridge()
})

afterEach(() => {
  setBridge(null)
})

describe('AgentsSection', () => {
  it('installs the skill with the graph generation pinned', async () => {
    await renderSection()
    await page.getByRole('button', { name: 'Install skill' }).click()

    await expect.element(page.getByText('Installed')).toBeInTheDocument()
    expect(installCalls).toEqual([{ generation: GRAPH.generation }])
    await expect
      .element(page.getByText('/Users/me/.agents/skills/reflect-personal/SKILL.md'))
      .toBeInTheDocument()
  })

  it('offers an update for a stale install and removal for any managed one', async () => {
    installState = 'stale'
    await renderSection()

    await page.getByRole('button', { name: 'Remove' }).click()
    await expect.element(page.getByRole('button', { name: 'Install skill' })).toBeInTheDocument()
    expect(uninstallCalls).toEqual([{ generation: GRAPH.generation }])
  })

  it('refuses to touch an unmanaged file', async () => {
    installState = 'conflict'
    await renderSection()

    await expect.element(page.getByText(/Reflect doesn’t manage/)).toBeInTheDocument()
    expect(page.getByRole('button', { name: 'Install skill' }).query()).toBeNull()
    expect(page.getByRole('button', { name: 'Remove' }).query()).toBeNull()
  })
})
