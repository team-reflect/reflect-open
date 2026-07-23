import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { setBridge } from '@reflect/core'
import { PaletteProvider, usePalette } from '@/components/command-palette/palette-provider'
import { flushOpenDocuments } from '@/editor/open-documents'
import type { NoteEditorHandle } from '@/editor/note-editor'
import { RouterProvider } from '@/routing/router'
import type { Route } from '@/routing/route'
import { setPlatformSurface } from '@/lib/platform-surface'
import '@/test-utils/locator'
import { RouteContent } from './route-content'

/**
 * The route → view seam (Plan 06): non-daily notes must be just as editable as
 * daily ones. These tests drive the real router → RouteContent → NotePane →
 * save-pipeline stack over a fake IPC bridge; only the ProseMirror view is
 * stubbed because editor-DOM behavior lives in the dedicated editor tests.
 */

const editorProbe = vi.hoisted(() => ({
  onChange: null as ((markdown: string) => void) | null,
  focusCalls: [] as string[],
  hoverRenderer: null as boolean | null,
}))

vi.mock('@/editor/note-editor', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    NoteEditor: ({
      initialContent,
      onChange,
      handleRef,
      renderWikilinkHoverCard,
    }: {
      initialContent: string
      onChange: (markdown: string) => void
      handleRef?: (handle: NoteEditorHandle | null) => void
      renderWikilinkHoverCard?: unknown
    }) => {
      editorProbe.hoverRenderer = renderWikilinkHoverCard !== undefined
      const markdownRef = useRef(initialContent)
      editorProbe.onChange = (markdown) => {
        markdownRef.current = markdown
        onChange(markdown)
      }
      useEffect(() => {
        handleRef?.({
          setMarkdown: (markdown) => {
            markdownRef.current = markdown
          },
          getMarkdown: () => markdownRef.current,
          insertMarkdown: () => {},
          focus: () => editorProbe.focusCalls.push('focus'),
          setSelection: () => {},
          getSelectedText: () => '',
          openSelectionMenu: () => {},
          startPendingReplacement: () => false,
          appendPendingReplacementText: () => {},
          acceptPendingReplacement: () => {},
          discardPendingReplacement: () => {},
        })
        return () => handleRef?.(null)
      }, [handleRef])
      return (
        <div data-testid="fake-editor" contentEditable suppressContentEditableWarning>
          {initialContent}
        </div>
      )
    },
  }
})

const indexFns = vi.hoisted(() => ({
  getBacklinksWithContext: vi.fn(async () => ({
    contexts: [],
    nextCursor: null,
    indexedLinkCount: 0,
  })),
  relatedNotes: vi.fn(async () => []),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext: indexFns.getBacklinksWithContext,
  relatedNotes: indexFns.relatedNotes,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      editorMarkdownSyntax: 'hide',
      allNotesFilterTags: ['book', 'link', 'person'],
      aiProviders: [],
      defaultAiProviderId: null,
      chatSystemPrompt: '',
      aiPrompts: [],
    },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
  }),
}))
vi.mock('@/components/daily-stream', () => ({
  DailyStream: () => <div data-testid="daily-stream" />,
}))
vi.mock('@/components/settings-screen', () => ({
  SettingsScreen: () => <div data-testid="settings-screen" />,
}))
// The chat screen needs the ChatProvider stack (covered by its own tests);
// here only the route → view mapping is under test.
vi.mock('@/components/chat/chat-screen', () => ({
  ChatScreen: () => <div data-testid="chat-screen" />,
}))

/** The fake graph: files behind the IPC bridge + a write log. */
let files: Record<string, string>
let writes: Array<{ path: string; contents: string }>
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()
const NEW_NOTE_PATH = 'notes/01arz3ndektsv4rrffq69g5fav.md'

setBridge({
  invoke: mockInvoke,
  listen: async () => () => {},
})

beforeEach(() => {
  files = {}
  writes = []
  editorProbe.onChange = null
  editorProbe.focusCalls.length = 0
  editorProbe.hoverRenderer = null
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'note_read') {
      const content = files[(args as { path: string }).path]
      if (content === undefined) {
        throw { kind: 'notFound', message: 'missing' } // AppError shape
      }
      return content
    }
    if (command === 'note_write') {
      const { path, contents } = args as { path: string; contents: string }
      files[path] = contents
      writes.push({ path, contents })
      return null
    }
    if (command === 'db_query') {
      return []
    }
    return null
  })
})

afterEach(async () => {
  await cleanup()
  setPlatformSurface({ touchEditor: false, mobileApp: false })
})

function PaletteProbe(): ReactElement {
  const { open, query } = usePalette()
  return <output data-testid="palette">{JSON.stringify({ open, query })}</output>
}

function renderRoute(route: Route) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={route}>
        <PaletteProvider>
          <RouteContent />
          <PaletteProbe />
        </PaletteProvider>
      </RouterProvider>
    </QueryClientProvider>,
  )
}

describe('RouteContent', () => {
  it('renders the daily stream for the today route', async () => {
    const view = await renderRoute({ kind: 'today' })
    await expect.element(page.getByTestId('daily-stream')).toBeInTheDocument()
    await view.unmount()
  })

  it('renders the daily stream for a daily route, surviving a malformed date', async () => {
    const view = await renderRoute({ kind: 'daily', date: '2026-02-31' })
    await expect.element(page.getByTestId('daily-stream')).toBeInTheDocument()
    await view.unmount()
  })

  it('renders an existing non-daily note as an editable pane, not the stream', async () => {
    files['notes/exist.md'] = '# Hello\n\nWorld.\n'
    const view = await renderRoute({ kind: 'note', path: 'notes/exist.md' })

    await expect.element(page.getByLabelText('Editing notes/exist.md')).toBeVisible()
    await expect.element(page.getByTestId('daily-stream')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('fake-editor')).toHaveTextContent('# Hello')
    expect(editorProbe.hoverRenderer).toBe(true)

    // The navigated-to note takes focus on mount.
    await vi.waitFor(() => expect(editorProbe.focusCalls).toContain('focus'))
    await view.unmount()
  })

  it('omits the wiki-link hover renderer on a touch editor surface', async () => {
    setPlatformSurface({ touchEditor: true })
    files['notes/exist.md'] = '# Hello\n'
    const view = await renderRoute({ kind: 'note', path: 'notes/exist.md' })

    await expect.element(page.getByLabelText('Editing notes/exist.md')).toBeVisible()
    expect(editorProbe.hoverRenderer).toBe(false)
    await view.unmount()
  })

  it('opens a missing note seeded with an empty focused title, writing nothing', async () => {
    const view = await renderRoute({ kind: 'note', path: NEW_NOTE_PATH })

    await expect.element(page.getByLabelText(`Editing ${NEW_NOTE_PATH}`)).toBeVisible()
    // The seed is an empty H1: the caret lands in it (plain focus, no text
    // to select) and the title placeholder ghosts "Untitled" over the line.
    expect(page.getByTestId('fake-editor').element().textContent).toBe('#\n')
    await vi.waitFor(() => expect(editorProbe.focusCalls).toContain('focus'))

    // Opening never litters the graph — even a forced flush writes nothing.
    await act(() => flushOpenDocuments())
    expect(writes).toEqual([])
    expect(files[NEW_NOTE_PATH]).toBeUndefined()
    await view.unmount()
  })

  it('creates the file once the user actually edits the seeded note', async () => {
    const view = await renderRoute({ kind: 'note', path: NEW_NOTE_PATH })
    await expect.element(page.getByLabelText(`Editing ${NEW_NOTE_PATH}`)).toBeVisible()

    await act(() => editorProbe.onChange?.('# Manifesto\n'))
    await act(() => flushOpenDocuments())

    // The seed's header rides along: the file is born with its identity
    // (`id:` frontmatter, Plan 17) plus exactly what the user typed.
    expect(files[NEW_NOTE_PATH]).toMatch(/^---\nid: [0-9a-z]{26}\n---\n# Manifesto\n$/)
    await view.unmount()
  })

  it('never recreates an arbitrary missing vault path', async () => {
    const view = await renderRoute({ kind: 'note', path: 'Projects/missing.md' })

    await expect.element(page.getByText(/Couldn’t open Projects\/missing\.md: missing/)).toBeVisible()
    await expect.element(page.getByTestId('fake-editor')).not.toBeInTheDocument()
    await act(() => flushOpenDocuments())
    expect(writes).toEqual([])
    expect(files['Projects/missing.md']).toBeUndefined()
    await view.unmount()
  })

  it('opens a note the editor cannot round-trip as read-only, never editable', async () => {
    // Git conflict markers are a known meowdown converter gap (see roundtrip.ts),
    // and get their own view: both sides shown, labeled by the marker names.
    files['notes/conflict.md'] =
      '# Shared\n\n<<<<<<< this device\nedited on a\n=======\nedited on b\n>>>>>>> other device\n'
    const view = await renderRoute({ kind: 'note', path: 'notes/conflict.md' })

    await expect.element(page.getByText(/edited on a/)).toBeVisible()
    await expect.element(page.getByTestId('fake-editor')).not.toBeInTheDocument()
    await expect.element(page.getByText('this device')).toBeVisible()
    await expect.element(page.getByText('other device')).toBeVisible()
    await expect.element(page.getByText(/edited on b/)).toBeVisible()
    await view.unmount()
  })

  it('renders the settings screen for the settings route', async () => {
    const view = await renderRoute({ kind: 'settings' })
    await expect.element(page.getByTestId('settings-screen')).toBeInTheDocument()
    await view.unmount()
  })

  it('renders the chat screen for the chat route, not the stream', async () => {
    const view = await renderRoute({ kind: 'chat' })
    await expect.element(page.getByTestId('chat-screen')).toBeInTheDocument()
    await expect.element(page.getByTestId('daily-stream')).not.toBeInTheDocument()
    await view.unmount()
  })

  it('renders the All Notes screen for the allNotes route, not the stream', async () => {
    const view = await renderRoute({ kind: 'allNotes', tag: null })
    await expect.element(page.getByLabelText('All notes')).toBeVisible()
    await expect.element(page.getByTestId('daily-stream')).not.toBeInTheDocument()
    // The pinned filter tabs come from settings; the table header renders
    // once the (empty) index query settles.
    await expect.element(page.getByRole('button', { name: '#book' })).toBeVisible()
    await expect.element(page.getByText('Subject')).toBeVisible()
    await expect.element(page.getByText('No notes yet.')).toBeVisible()
    await view.unmount()
  })

  it('arriving on a search route opens the palette pre-filled over the stream', async () => {
    const view = await renderRoute({ kind: 'search', query: 'roadmap' })
    await expect.element(page.getByTestId('daily-stream')).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(JSON.parse(page.getByTestId('palette').element().textContent ?? '')).toEqual({
        open: true,
        query: 'roadmap',
      }),
    )
    await view.unmount()
  })
})
