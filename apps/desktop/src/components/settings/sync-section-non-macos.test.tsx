import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import '@/test-utils/locator'
import { RouterProvider } from '@/routing/router'
import { SyncSection } from './sync-section'

// A browser-mode module mock materializes value exports once, so the
// platform-hidden behavior needs its own file with the flag statically false
// (see `sync-section.test.tsx` for the macOS suite).
vi.mock('@/lib/platform', () => ({ isMacosDesktop: false }))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  icloudStatus: vi.fn(async () => ({
    available: true,
    documentsRoot: '/Users/alex/Library/Mobile Documents/iCloud~app/Documents',
    existingGraphRoots: [],
  })),
  icloudPendingCount: vi.fn(async () => 0),
  getConflictedNotes: vi.fn(async () => []),
  getDuplicateNoteIds: vi.fn(async () => []),
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: {
      root: '/Users/alex/Library/Mobile Documents/iCloud~app/Documents/Notes',
      name: 'Notes',
      generation: 1,
    },
    openRecent: vi.fn(async () => true),
  }),
}))
vi.mock('@/providers/sync-provider', () => ({
  useSync: () => ({
    backup: { phase: 'disconnected' },
    disconnectGraph: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    backUpNow: vi.fn(async () => {}),
  }),
}))

describe('SyncSection off macOS desktop', () => {
  it('keeps backup visible when the iCloud row is platform-hidden', async () => {
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider initialRoute={{ kind: 'settings' }}>
          <SyncSection />
        </RouterProvider>
      </QueryClientProvider>,
    )

    const section = page.getByRole('region', { name: 'Sync' })
    expect(section.locate('legend').filter({ hasText: 'iCloud Drive' }).query()).toBeNull()
    await expect
      .element(section.locate('legend').filter({ hasText: 'GitHub sync' }))
      .toBeInTheDocument()
  })
})
