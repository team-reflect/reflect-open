import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { AgentsSection } from './agents-section'

// A browser-mode module mock materializes value exports once, so the
// off-macOS behavior needs its own file with the flag statically false
// (see `agents-section.test.tsx` for the macOS suite).
vi.mock('@/lib/platform', () => ({ isMacosDesktop: false }))

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/graphs/Personal', name: 'Personal', generation: 7 } }),
}))

describe('AgentsSection off macOS desktop', () => {
  it('renders nothing off macOS desktop', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await render(
      <QueryClientProvider client={queryClient}>
        <AgentsSection />
      </QueryClientProvider>,
    )
    expect(page.getByText('Agent skill').query()).toBeNull()
  })
})
