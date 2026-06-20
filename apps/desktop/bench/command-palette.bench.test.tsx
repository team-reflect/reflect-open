/**
 * Flow 4 — command palette: search + preview navigation churn.
 *
 * Two memoizations are measured against the REAL CommandPalette:
 *   1. `React.memo(Snippet)` — each visible result row renders a Snippet that
 *      runs `parseHighlights` on its snippet string. Typing changes `query`
 *      and re-renders the palette; an unchanged snippet should not re-run
 *      parseHighlights. Metric: parseHighlights calls across keystrokes.
 *   2. stable `key="note-preview"` on `<NotePreview>` — moving the highlight
 *      with ↓ should update the preview, not unmount/remount it. Metric:
 *      NotePreview mount count across arrow presses.
 *
 * `usePaletteResults` is mocked to feed the large dataset's result set directly
 * (no search plumbing), so the only variable is the palette's own render churn.
 */

import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import type { CommandContext } from '@/lib/commands/types'
import type { NoteEntry } from '@/components/command-palette/entries'
import { buildDataset } from './lib/dataset'
import { record } from './lib/record'

const dataset = buildDataset()
const counters = { parseHighlights: 0, notePreviewMounts: 0 }

const realParseHighlights =
  await vi.importActual<typeof import('@reflect/core')>('@reflect/core')
vi.mock('@reflect/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@reflect/core')>()
  return {
    ...actual,
    hasBridge: () => true,
    parseHighlights: (snippet: string) => {
      counters.parseHighlights += 1
      return actual.parseHighlights(snippet)
    },
  }
})
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: { dateFormat: 'mdy', semanticSearchEnabled: false }, updateSettings: () => {} }),
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }),
}))
// Feed the palette a fixed, large result set so only render churn varies.
vi.mock('@/components/command-palette/use-palette-results', () => ({
  usePaletteResults: () => ({
    sections: { notes: dataset.paletteNotes, commands: [], commandsOnly: false },
    resultsSettled: true,
    searchFailed: false,
  }),
}))
// A mount-counting stand-in for the preview: its mount count is exactly the
// quantity the stable key changes (remount-per-arrow vs update-in-place).
vi.mock('@/components/command-palette/note-preview', () => ({
  NotePreview: ({ entry }: { entry: NoteEntry }) => {
    useEffect(() => {
      counters.notePreviewMounts += 1
    }, [])
    return <div data-testid="bench-preview">{entry.path}</div>
  },
}))

const { CommandPalette } = await import('@/components/command-palette/command-palette')
const { PaletteProvider, usePalette } = await import('@/components/command-palette/palette-provider')

void realParseHighlights

window.HTMLElement.prototype.scrollIntoView = () => {}
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

afterEach(cleanup)

function OpenOnMount({ query }: { query: string }): null {
  const { openPalette } = usePalette()
  useEffect(() => {
    openPalette(query)
  }, [openPalette, query])
  return null
}

function renderPalette(query: string): ReturnType<typeof render> {
  const context: CommandContext = {
    navigate: vi.fn(),
    route: () => ({ kind: 'today' }),
    notePath: () => null,
    back: vi.fn(),
    forward: vi.fn(),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    toggleAudioMemo: vi.fn(),
    generation: () => 1,
    openPalette: vi.fn(),
    openShortcuts: vi.fn(),
    enableSemanticSearch: vi.fn(),
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <PaletteProvider>
        <OpenOnMount query={query} />
        <CommandPalette context={context} />
      </PaletteProvider>
    </QueryClientProvider>,
  )
}

describe('CommandPalette churn (search + preview nav)', () => {
  it('measures parseHighlights reruns while typing', async () => {
    counters.parseHighlights = 0
    const user = userEvent.setup()
    const view = renderPalette('a')
    await waitFor(() => expect(view.getAllByTestId('bench-preview').length).toBeGreaterThan(0))

    const afterMount = counters.parseHighlights
    const KEYSTROKES = 10
    const input = view.getByPlaceholderText('Search notes, or > for commands…')
    input.focus()
    await user.keyboard('bcdefghijk'.slice(0, KEYSTROKES))
    const afterTyping = counters.parseHighlights

    record({
      flow: 'flow-4a-palette-snippet-typing',
      description:
        `parseHighlights calls while typing ${KEYSTROKES} characters over a ` +
        `${dataset.paletteNotes.length}-result palette (mount vs typing).`,
      metrics: {
        results: dataset.paletteNotes.length,
        keystrokes: KEYSTROKES,
        mountParseHighlightsCalls: afterMount,
        typingParseHighlightsCalls: afterTyping - afterMount,
        totalParseHighlightsCalls: afterTyping,
      },
    })
    expect(afterTyping).toBeGreaterThanOrEqual(afterMount)
  })

  it('measures NotePreview mounts while moving the highlight with ArrowDown', async () => {
    counters.notePreviewMounts = 0
    const user = userEvent.setup()
    const view = renderPalette('a')
    await waitFor(() => expect(view.getAllByTestId('bench-preview').length).toBeGreaterThan(0))

    const afterOpen = counters.notePreviewMounts
    const ARROWS = 15
    const input = view.getByPlaceholderText('Search notes, or > for commands…')
    input.focus()
    for (let index = 0; index < ARROWS; index += 1) {
      await user.keyboard('{ArrowDown}')
    }
    const afterArrows = counters.notePreviewMounts

    record({
      flow: 'flow-4b-palette-preview-nav',
      description:
        `NotePreview mount count across ${ARROWS} ArrowDown presses (remount-per-arrow ` +
        `vs update-in-place under a stable key).`,
      metrics: {
        arrowPresses: ARROWS,
        mountsAfterOpen: afterOpen,
        mountsDuringArrows: afterArrows - afterOpen,
        totalMounts: afterArrows,
      },
    })
    expect(afterArrows).toBeGreaterThanOrEqual(afterOpen)
  })
})
