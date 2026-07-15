import { act, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, type ReactElement } from 'react'
import { emitFileChanges, setBridge } from '@reflect/core'
import { PaletteProvider, usePalette } from '@/components/command-palette/palette-provider'
import { flushOpenDocuments } from '@/editor/open-documents'
import type { NoteEditorHandle } from '@/editor/note-editor'
import { RouterProvider } from '@/routing/router'
import type { Route } from '@/routing/route'
import { setPlatformSurface } from '@/lib/platform-surface'
import {
  consumeNewNoteCreationClaim,
  grantNewNoteCreation,
  hasNewNoteCreationClaim,
} from '@/lib/new-note-creation-claims'
import { RouteContent } from './route-content'

/**
 * The route → view seam (Plan 06): non-daily notes must be just as editable as
 * daily ones. These tests drive the real router → RouteContent → NotePane →
 * save-pipeline stack over a fake IPC bridge; only the ProseMirror view is
 * stubbed (jsdom can't host contenteditable — editor-DOM behavior lives in the
 * editor tests and, later, browser-mode vitest).
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
          revealHeading: () => false,
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
const graphState = vi.hoisted(() => ({
  graph: { root: '/g', name: 'g', generation: 1 },
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: graphState.graph,
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
      aiPrompts: [],
    },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
  }),
}))
vi.mock('@/components/settings-screen', () => ({
  SettingsScreen: () => <div data-testid="settings-screen" />,
}))
// The chat screen needs the ChatProvider stack (covered by its own tests);
// here only the route → view mapping is under test.
vi.mock('@/components/chat/chat-screen', () => ({
  ChatScreen: () => <div data-testid="chat-screen" />,
}))

// jsdom implements neither — the daily stream's virtualizer needs both.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
Element.prototype.scrollTo ??= () => {}

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
  graphState.graph = { root: '/g', name: 'g', generation: 1 }
  consumeNewNoteCreationClaim(graphState.graph, NEW_NOTE_PATH)
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
    if (command === 'note_write_if_unchanged') {
      const { path, contents, expected } = args as {
        path: string
        contents: string
        expected: string | null
      }
      if ((files[path] ?? null) !== expected) {
        return { kind: 'changed' }
      }
      files[path] = contents
      writes.push({ path, contents })
      return { kind: 'written', modifiedMs: null }
    }
    if (command === 'db_query') {
      return []
    }
    return null
  })
})

afterEach(() => {
  setPlatformSurface({ touchEditor: false, mobileApp: false })
})

function PaletteProbe(): ReactElement {
  const { open, query } = usePalette()
  return <output data-testid="palette">{JSON.stringify({ open, query })}</output>
}

function renderRoute(route: Route, strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const content = (
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={route}>
        <PaletteProvider>
          <RouteContent />
          <PaletteProbe />
        </PaletteProvider>
      </RouterProvider>
    </QueryClientProvider>
  )
  return render(strict ? <StrictMode>{content}</StrictMode> : content)
}

describe('RouteContent', () => {
  it('renders the daily stream for the today route', () => {
    const view = renderRoute({ kind: 'today' })
    expect(view.getByTestId('daily-stream')).toBeDefined()
    view.unmount()
  })

  it('renders the daily stream for a daily route, surviving a malformed date', () => {
    const view = renderRoute({ kind: 'daily', date: '2026-02-31' })
    expect(view.getByTestId('daily-stream')).toBeDefined()
    view.unmount()
  })

  it('renders an existing non-daily note as an editable pane, not the stream', async () => {
    files['notes/exist.md'] = '# Hello\n\nWorld.\n'
    const view = renderRoute({ kind: 'note', path: 'notes/exist.md' })

    await view.findByLabelText('Editing notes/exist.md')
    expect(view.queryByTestId('daily-stream')).toBeNull()
    expect(view.getByTestId('fake-editor').textContent).toContain('# Hello')
    expect(editorProbe.hoverRenderer).toBe(true)

    // The navigated-to note takes focus on mount.
    await waitFor(() => expect(editorProbe.focusCalls).toContain('focus'))
    view.unmount()
  })

  it('omits the wiki-link hover renderer on a touch editor surface', async () => {
    setPlatformSurface({ touchEditor: true })
    files['notes/exist.md'] = '# Hello\n'
    const view = renderRoute({ kind: 'note', path: 'notes/exist.md' })

    await view.findByLabelText('Editing notes/exist.md')
    expect(editorProbe.hoverRenderer).toBe(false)
    view.unmount()
  })

  it('opens a missing note seeded with an empty focused title, writing nothing', async () => {
    grantNewNoteCreation(graphState.graph, NEW_NOTE_PATH)
    const view = renderRoute({ kind: 'note', path: NEW_NOTE_PATH })

    await view.findByLabelText(`Editing ${NEW_NOTE_PATH}`)
    // The seed is an empty H1: the caret lands in it (plain focus, no text
    // to select) and the title placeholder ghosts "Untitled" over the line.
    expect(view.getByTestId('fake-editor').textContent).toBe('#\n')
    await waitFor(() => expect(editorProbe.focusCalls).toContain('focus'))

    // Opening never litters the graph — even a forced flush writes nothing.
    await act(() => flushOpenDocuments())
    expect(writes).toEqual([])
    expect(files[NEW_NOTE_PATH]).toBeUndefined()
    view.unmount()
  })

  it('creates the file once the user actually edits the seeded note', async () => {
    grantNewNoteCreation(graphState.graph, NEW_NOTE_PATH)
    const view = renderRoute({ kind: 'note', path: NEW_NOTE_PATH })
    await view.findByLabelText(`Editing ${NEW_NOTE_PATH}`)

    act(() => editorProbe.onChange?.('# Manifesto\n'))
    await act(() => flushOpenDocuments())

    // The seed's header rides along: the file is born with its identity
    // (`id:` frontmatter, Plan 17) plus exactly what the user typed.
    expect(files[NEW_NOTE_PATH]).toMatch(/^---\nid: [0-9a-z]{26}\n---\n# Manifesto\n$/)
    view.unmount()
  })

  it('keeps the scoped creation grant stable through Strict Mode render replay', async () => {
    grantNewNoteCreation(graphState.graph, NEW_NOTE_PATH)
    const view = renderRoute({ kind: 'note', path: NEW_NOTE_PATH }, true)
    await view.findByLabelText(`Editing ${NEW_NOTE_PATH}`)

    act(() => editorProbe.onChange?.('# Strict note\n'))
    await act(() => flushOpenDocuments())

    expect(writes).toHaveLength(1)
    expect(files[NEW_NOTE_PATH]).toMatch(/# Strict note\n$/)
    view.unmount()
  })

  it('does not recreate a managed Reflect note removed while its editor is open', async () => {
    const source = `---\nid: ${NEW_NOTE_PATH.slice('notes/'.length, -'.md'.length)}\n---\n# Existing draft\n`
    files[NEW_NOTE_PATH] = source
    const view = renderRoute({ kind: 'note', path: NEW_NOTE_PATH })
    await view.findByLabelText(`Editing ${NEW_NOTE_PATH}`)

    delete files[NEW_NOTE_PATH]
    act(() => emitFileChanges([{ path: NEW_NOTE_PATH, kind: 'remove' }]))
    act(() => editorProbe.onChange?.('# Existing draft\n\nPreserved only in the editor.\n'))
    await act(() => flushOpenDocuments())

    expect(files[NEW_NOTE_PATH]).toBeUndefined()
    expect(writes).toEqual([])
    view.unmount()
  })

  it('does not infer a fresh creation grant from a missing ULID-shaped route', async () => {
    const view = renderRoute({ kind: 'note', path: NEW_NOTE_PATH })

    await view.findByText(new RegExp(`Couldn’t open ${NEW_NOTE_PATH}: missing`))
    expect(view.queryByTestId('fake-editor')).toBeNull()
    expect(files[NEW_NOTE_PATH]).toBeUndefined()
    view.unmount()
  })

  it('does not restore a consumed New Note grant after deletion and remount', async () => {
    grantNewNoteCreation(graphState.graph, NEW_NOTE_PATH)
    const first = renderRoute({ kind: 'note', path: NEW_NOTE_PATH })
    await first.findByLabelText(`Editing ${NEW_NOTE_PATH}`)
    act(() => editorProbe.onChange?.('# Created once\n'))
    await act(() => flushOpenDocuments())
    first.unmount()

    delete files[NEW_NOTE_PATH]
    const reopened = renderRoute({ kind: 'note', path: NEW_NOTE_PATH })
    await reopened.findByText(new RegExp(`Couldn’t open ${NEW_NOTE_PATH}: missing`))
    expect(reopened.queryByTestId('fake-editor')).toBeNull()
    expect(writes).toHaveLength(1)
    reopened.unmount()
  })

  it('never carries an unconsumed New Note grant across a graph switch or reopen', async () => {
    const originalGraph = { ...graphState.graph }
    grantNewNoteCreation(originalGraph, NEW_NOTE_PATH)
    const otherScopes = [
      { root: '/other-vault', name: 'other', generation: originalGraph.generation },
      { ...originalGraph, generation: originalGraph.generation + 1 },
    ]

    for (const scope of otherScopes) {
      graphState.graph = scope
      const view = renderRoute({ kind: 'note', path: NEW_NOTE_PATH })

      await view.findByText(new RegExp(`Couldn’t open ${NEW_NOTE_PATH}: missing`))
      expect(view.queryByTestId('fake-editor')).toBeNull()
      expect(files[NEW_NOTE_PATH]).toBeUndefined()
      expect(hasNewNoteCreationClaim(scope, NEW_NOTE_PATH)).toBe(false)
      view.unmount()
    }
    expect(hasNewNoteCreationClaim(originalGraph, NEW_NOTE_PATH)).toBe(true)
  })

  it('never recreates an arbitrary missing vault path', async () => {
    const view = renderRoute({ kind: 'note', path: 'Projects/missing.md' })

    await view.findByText(/Couldn’t open Projects\/missing\.md: missing/)
    expect(view.queryByTestId('fake-editor')).toBeNull()
    await act(() => flushOpenDocuments())
    expect(writes).toEqual([])
    expect(files['Projects/missing.md']).toBeUndefined()
    view.unmount()
  })

  it('does not recreate an adopted vault note removed while its editor is open', async () => {
    const path = 'Projects/adopted.md'
    files[path] = '# Adopted\n'
    const view = renderRoute({ kind: 'note', path })
    await view.findByLabelText(`Editing ${path}`)

    delete files[path]
    act(() => emitFileChanges([{ path, kind: 'remove' }]))
    expect(view.getByText(/Reflect can’t safely save to this missing path/)).toBeDefined()
    act(() => editorProbe.onChange?.('# Preserved only in the editor\n'))
    await act(() => flushOpenDocuments())

    expect(files[path]).toBeUndefined()
    expect(writes).toEqual([])

    view.unmount()
    expect(files[path]).toBeUndefined()
    expect(writes).toEqual([])
  })

  it('opens a note the editor cannot round-trip as read-only, never editable', async () => {
    // Git conflict markers are a known meowdown converter gap (see roundtrip.ts),
    // and get their own view: both sides shown, labeled by the marker names.
    files['notes/conflict.md'] =
      '# Shared\n\n<<<<<<< this device\nedited on a\n=======\nedited on b\n>>>>>>> other device\n'
    const view = renderRoute({ kind: 'note', path: 'notes/conflict.md' })

    await view.findByText(/edited on a/)
    expect(view.queryByTestId('fake-editor')).toBeNull()
    expect(view.getByText('this device')).toBeDefined()
    expect(view.getByText('other device')).toBeDefined()
    expect(view.getByText(/edited on b/)).toBeDefined()
    view.unmount()
  })

  it('renders the settings screen for the settings route', () => {
    const view = renderRoute({ kind: 'settings' })
    expect(view.getByTestId('settings-screen')).toBeDefined()
    view.unmount()
  })

  it('renders the chat screen for the chat route, not the stream', () => {
    const view = renderRoute({ kind: 'chat' })
    expect(view.getByTestId('chat-screen')).toBeDefined()
    expect(view.queryByTestId('daily-stream')).toBeNull()
    view.unmount()
  })

  it('renders the All Notes screen for the allNotes route, not the stream', async () => {
    const view = renderRoute({ kind: 'allNotes', tag: null })
    expect(view.getByLabelText('All notes')).toBeDefined()
    expect(view.queryByTestId('daily-stream')).toBeNull()
    // The pinned filter tabs come from settings; the table header renders
    // once the (empty) index query settles.
    expect(view.getByRole('button', { name: '#book' })).toBeDefined()
    await view.findByText('Subject')
    expect(view.getByText('No notes yet.')).toBeDefined()
    view.unmount()
  })

  it('arriving on a search route opens the palette pre-filled over the stream', async () => {
    const view = renderRoute({ kind: 'search', query: 'roadmap' })
    expect(view.getByTestId('daily-stream')).toBeDefined()
    await waitFor(() =>
      expect(JSON.parse(view.getByTestId('palette').textContent ?? '')).toEqual({
        open: true,
        query: 'roadmap',
      }),
    )
    view.unmount()
  })
})
