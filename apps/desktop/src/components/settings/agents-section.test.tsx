import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { AgentsSection } from './agents-section'

const platform = vi.hoisted(() => ({ isMacosDesktop: true }))
vi.mock('@/lib/platform', () => ({
  get isMacosDesktop() {
    return platform.isMacosDesktop
  },
}))

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

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AgentsSection />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  platform.isMacosDesktop = true
  installState = 'missing'
  installFakeBridge()
})

afterEach(() => {
  cleanup()
  setBridge(null)
})

describe('AgentsSection', () => {
  it('installs the skill with the graph generation pinned', async () => {
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Install skill' }))

    await waitFor(() => expect(screen.getByText('Installed')).toBeTruthy())
    expect(installCalls).toEqual([{ generation: GRAPH.generation }])
    expect(screen.getByText('/Users/me/.agents/skills/reflect-personal/SKILL.md')).toBeTruthy()
  })

  it('offers an update for a stale install and removal for any managed one', async () => {
    installState = 'stale'
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Install skill' })).toBeTruthy(),
    )
    expect(uninstallCalls).toEqual([{ generation: GRAPH.generation }])
  })

  it('refuses to touch an unmanaged file', async () => {
    installState = 'conflict'
    renderSection()

    await screen.findByText(/Reflect doesn’t manage/)
    expect(screen.queryByRole('button', { name: 'Install skill' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('renders nothing off macOS desktop', () => {
    platform.isMacosDesktop = false
    renderSection()
    expect(screen.queryByText('Agent skill')).toBeNull()
  })
})
