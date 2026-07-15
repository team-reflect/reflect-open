import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { setPlatformSurface } from '@/lib/platform-surface'
import { MobileNote } from '@/mobile/screens/note'
import { RouterProvider } from '@/routing/router'

/**
 * Conflict containment on the mobile note screen (Plan 19, step 10): a note
 * whose file carries sync conflict markers opens **protected** — the same
 * session contract as desktop (markers classify as lossy through the real
 * round-trip check) — with the raw file visible and the same marker-resolution
 * actions desktop offers. Only the ProseMirror view is stubbed (jsdom can't
 * host contenteditable).
 */

vi.mock('@/editor/note-editor', () => ({
  NoteEditor: () => <div data-testid="fake-editor" />,
}))

vi.mock('@/mobile/note-actions-menu', () => ({
  NoteActionsMenu: () => null,
}))

const CONFLICTED = [
  '# Standup',
  '<<<<<<< this device',
  '- phone line',
  '=======',
  '- desktop line',
  '>>>>>>> other device',
  '',
].join('\n')

const NOTE_ROW = {
  path: 'notes/standup.md',
  title: 'Standup',
  dailyDate: null,
  isPrivate: false,
  hasConflict: true,
  gistUrl: null,
  gistStale: false,
}

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getNote: vi.fn(async () => NOTE_ROW),
  getBacklinksWithContext: vi.fn(async () => ({
    contexts: [],
    nextCursor: null,
    indexedLinkCount: 0,
  })),
}))

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      editorMarkdownSyntax: 'hide',
      editorDefaultBullet: false,
      aiProviders: [],
      defaultAiProviderId: null,
      chatSystemPrompt: '',
      aiPrompts: [],
    },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
  }),
}))

setBridge({
  invoke: async (command) => {
    if (command === 'note_read') {
      return CONFLICTED
    }
    if (command === 'db_query') {
      return []
    }
    return null
  },
  listen: async () => () => {},
})

let queryClient: QueryClient

beforeEach(() => {
  setPlatformSurface({ mobileApp: true })
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  setPlatformSurface({ mobileApp: false })
  vi.clearAllMocks()
})

describe('MobileNote with a conflicted note', () => {
  it('opens protected with raw markers and conflict resolution actions', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider initialRoute={{ kind: 'note', path: 'notes/standup.md' }}>
          <MobileNote path="notes/standup.md" />
        </RouterProvider>
      </QueryClientProvider>,
    )

    expect(await screen.findByText(/choose what to keep/i)).toBeTruthy()
    // Protected: raw file shown verbatim, no live editor mounted.
    expect(screen.getByText(/desktop line/)).toBeTruthy()
    expect(screen.queryByTestId('fake-editor')).toBeNull()
    expect(screen.getByRole('button', { name: /keep this device’s version/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /keep the other device’s/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /keep both/i })).toBeTruthy()
  })
})
