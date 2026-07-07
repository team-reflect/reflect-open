import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import {
  cloudSafeGraphContext,
  type AiProviderConfig,
  type ChatModelSelection,
  type ChatStreamEvent,
  type CloudGraphContext,
  type CloudSafe,
  type GraphContextDeps,
  type GraphInfo,
  type Settings,
  type StreamChatOptions,
} from '@reflect/core'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ChatProvider, useChatSession } from '@/providers/chat-provider'
import { RouterProvider, useRouter } from '@/routing/router'

/**
 * The chat view over a faked engine: the provider stack and screen are real,
 * `streamChat` is scripted. Covers the no-provider call-to-action, a full
 * grounded turn (user bubble → tool chip → cited answer), the model picker,
 * the plain-while-streaming text rendering, abort-on-unmount, New chat, and
 * photo attachments (drop → preview → image-only send).
 */

const streamChat = vi.hoisted(() =>
  vi.fn<(options: StreamChatOptions) => AsyncGenerator<ChatStreamEvent>>(),
)
const getSecret = vi.hoisted(() => vi.fn<(name: string) => Promise<string | null>>())
const resolveWikiTarget = vi.hoisted(() =>
  vi.fn<(target: string) => Promise<{ kind: 'resolved'; ref: string } | { kind: 'unresolved'; text: string }>>(),
)
const loadChatGraphContext = vi.hoisted(() =>
  vi.fn<
    (graphName: string, deps?: GraphContextDeps) => Promise<CloudSafe<CloudGraphContext>>
  >(),
)
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  streamChat,
  getSecret,
  resolveWikiTarget,
  loadChatGraphContext,
}))

const settingsState = vi.hoisted(() => ({
  models: [] as AiProviderConfig[],
  defaultId: null as string | null,
  selection: null as ChatModelSelection | null,
}))
// Stateful like the real provider: a chatModelSelection patch re-renders with
// the new value, so picking a model in the UI applies instantly here too.
vi.mock('@/providers/settings-provider', async () => {
  const { useState } = await import('react')
  return {
    useSettings: () => {
      const [selection, setSelection] = useState(settingsState.selection)
      return {
        settings: {
          aiProviders: settingsState.models,
          defaultAiProviderId: settingsState.defaultId,
          chatModelSelection: selection,
        },
        updateSettings: (patch: Partial<Settings>) => {
          if (patch.chatModelSelection !== undefined) {
            setSelection(patch.chatModelSelection)
          }
        },
      }
    },
  }
})

// No open index → the provider's persistence layer stays inert; these tests
// cover the screen, chat-provider.test.tsx covers persistence.
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ indexGeneration: null, graph: null }),
}))

// jsdom can't host the ProseMirror contenteditable (same stub as the palette
// tests); markdown rendering is the editor's concern, not this screen's.
vi.mock('@/editor/markdown-preview', () => ({
  MarkdownPreview: ({
    content,
    onWikiLinkClick,
  }: {
    content: string
    onWikiLinkClick?: (target: string) => void
  }) => {
    const wikiTargets = Array.from(content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)).map(
      (match) => match[1]!,
    )
    return (
      <div data-testid="markdown-preview">
        {content}
        {wikiTargets.map((target) => (
          <button key={target} type="button" onClick={() => onWikiLinkClick?.(target)}>
            Open {target}
          </button>
        ))}
      </div>
    )
  },
}))
vi.mock('@/lib/provider-fetch', () => ({ providerFetch: vi.fn() }))

// jsdom doesn't implement this; Radix Select scrolls the selected option into
// view when the listbox opens.
Element.prototype.scrollIntoView ??= () => {}
// shadcn's MessageScroller drives the viewport with scrollTo; jsdom has no
// layout engine, so the browser API is stubbed for interaction tests.
Element.prototype.scrollTo ??= () => {}

const { ChatScreen } = await import('./chat-screen')

afterEach(cleanup)

const GRAPH: GraphInfo = { root: '/graphs/test', name: 'test-graph', generation: 1 }

const GRAPH_CONTEXT = cloudSafeGraphContext({
  graphName: 'test-graph',
  noteCount: 3,
  dailyNoteCount: 1,
  earliestDailyDate: '2026-06-01',
  latestDailyDate: '2026-06-01',
  tags: [{ tag: 'book', count: 2 }],
  tagsTruncated: false,
})

beforeEach(() => {
  settingsState.models = []
  settingsState.defaultId = null
  settingsState.selection = null
  streamChat.mockReset()
  getSecret.mockReset().mockResolvedValue('sk-test')
  loadChatGraphContext.mockReset().mockResolvedValue(GRAPH_CONTEXT)
  resolveWikiTarget.mockReset().mockImplementation(async (target) => ({
    kind: 'resolved',
    ref: `notes/${target.toLowerCase()}.md`,
  }))
})

const MODEL: AiProviderConfig = { id: 'm1', provider: 'openai', model: 'gpt-5.1', keyHint: '12345' }

function configureModel() {
  settingsState.models = [MODEL]
  settingsState.defaultId = 'm1'
}

function scriptTurn(events: ChatStreamEvent[]) {
  streamChat.mockImplementation(function script() {
    return (async function* () {
      yield* events
    })()
  })
}

/** A tiny PNG-magic-bytes file — base64 `iVBORw==` once read. */
function pngFile(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })
}

let probedSend: ((text: string) => Promise<void>) | null = null
let probedNewChat: (() => void) | null = null
let probedRoute: unknown = null

function SendProbe(): ReactElement | null {
  const session = useChatSession()
  probedSend = session.send
  probedNewChat = session.newChat
  return null
}

function RouteProbe(): ReactElement | null {
  probedRoute = useRouter().route
  return null
}

function renderChat() {
  probedSend = null
  probedRoute = null
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <TooltipProvider>
          <ChatProvider graph={GRAPH}>
            <ChatScreen />
            <SendProbe />
            <RouteProbe />
          </ChatProvider>
        </TooltipProvider>
      </RouterProvider>
    </QueryClientProvider>,
  )
}

describe('ChatScreen', () => {
  it('shows the add-a-provider call to action when nothing is configured', () => {
    const view = renderChat()
    expect(view.getByRole('button', { name: /add an ai provider/i })).toBeDefined()
    expect(view.queryByLabelText('Chat message')).toBeNull()
  })

  it('runs a grounded turn: user bubble, search chip, cited answer', async () => {
    configureModel()
    scriptTurn([
      { type: 'tool-call', call: { tool: 'search', toolCallId: 'tool-1', query: 'atlas' } },
      {
        type: 'tool-result',
        result: {
          tool: 'search',
          toolCallId: 'tool-1',
          query: 'atlas',
          hits: [{ path: 'notes/atlas.md', title: 'Atlas' }],
        },
      },
      { type: 'text-delta', text: 'It ships in June. [[Atlas]]' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'It ships in June. [[Atlas]]' }] },
    ])
    const view = renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'when does atlas ship?{Enter}')

    expect(view.getByText('when does atlas ship?')).toBeDefined()
    await view.findByText(/Searched “atlas” · 1 note/)
    // The turn settled, so the answer renders as markdown (not plain text).
    await waitFor(() =>
      expect(view.getByTestId('markdown-preview').textContent).toContain('It ships in June.'),
    )
    await userEvent.click(view.getByRole('button', { name: 'Atlas' }))
    expect(probedRoute).toEqual({ kind: 'note', path: 'notes/atlas.md' })

    // The turn went out with the keychain key and the full derived history.
    expect(getSecret).toHaveBeenCalledWith('ai-api-key:m1')
    const options = streamChat.mock.lastCall?.[0]
    expect(options?.config).toEqual(MODEL)
    expect(options?.messages.at(-1)).toEqual({ role: 'user', content: 'when does atlas ship?' })
  })

  it('opens cited wiki links from settled chat markdown', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'See [[Atlas]] and #book.' },
      {
        type: 'complete',
        messages: [{ role: 'assistant', content: 'See [[Atlas]] and #book.' }],
      },
    ])
    const view = renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'what should I open?{Enter}')
    await userEvent.click(await view.findByRole('button', { name: 'Open Atlas' }))

    await waitFor(() => expect(probedRoute).toEqual({ kind: 'note', path: 'notes/atlas.md' }))
  })

  it('offers the provider catalog in the picker, keeping a custom model selectable', async () => {
    configureModel()
    const view = renderChat()

    // Keyboard-driven (the pointer path needs capture APIs jsdom lacks);
    // options render in a portal, so they're queried from screen.
    fireEvent.keyDown(view.getByRole('combobox', { name: 'Model' }), { key: 'ArrowDown' })

    expect(await screen.findByText('OpenAI')).toBeDefined()
    const labels = screen.getAllByRole('option').map((option) => option.textContent)
    // The full curated catalog plus the entry's custom configured model.
    expect(labels).toEqual(['GPT-5.5', 'GPT-5.4', 'GPT-5.4 mini', 'GPT-5.4 nano', 'gpt-5.1'])
  })

  it('routes the turn to the picked catalog model', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'Hi.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] },
    ])
    const view = renderChat()

    fireEvent.keyDown(view.getByRole('combobox', { name: 'Model' }), { key: 'ArrowDown' })
    fireEvent.keyDown(await screen.findByRole('option', { name: 'GPT-5.5' }), { key: 'Enter' })

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')

    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1))
    // Same entry (id → keychain key), with the picked model applied.
    expect(streamChat.mock.lastCall?.[0].config).toEqual({ ...MODEL, model: 'gpt-5.5' })
  })

  it('starts the picker on the model persisted from the last session', async () => {
    configureModel()
    settingsState.selection = { configId: 'm1', modelId: 'gpt-5.5' }
    const view = renderChat()

    fireEvent.keyDown(view.getByRole('combobox', { name: 'Model' }), { key: 'ArrowDown' })

    const picked = await screen.findByRole('option', { name: 'GPT-5.5' })
    expect(picked.getAttribute('aria-selected')).toBe('true')
  })

  it('sends the graph overview context with each turn', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'Hi.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] },
    ])
    const view = renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')

    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1))
    expect(loadChatGraphContext).toHaveBeenCalledWith('test-graph')
    expect(streamChat.mock.lastCall?.[0].context).toEqual(GRAPH_CONTEXT)
  })

  it('still sends the turn, without an overview, when the context load fails', async () => {
    configureModel()
    loadChatGraphContext.mockRejectedValue(new Error('index not open'))
    scriptTurn([
      { type: 'text-delta', text: 'Hi.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] },
    ])
    const view = renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')

    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1))
    expect(streamChat.mock.lastCall?.[0].context).toBeNull()
    expect(await view.findByText('Hi.')).toBeDefined()
  })

  it('renders listing chips: recent notes by tag and a daily range', async () => {
    configureModel()
    scriptTurn([
      { type: 'tool-call', call: { tool: 'recents', toolCallId: 'tool-1', tag: 'book' } },
      {
        type: 'tool-result',
        result: {
          tool: 'recents',
          toolCallId: 'tool-1',
          tag: 'book',
          notes: [{ path: 'notes/atlas.md', title: 'Atlas' }],
          error: null,
        },
      },
      { type: 'tool-call', call: { tool: 'recents', toolCallId: 'tool-3', tag: '*' } },
      {
        type: 'tool-result',
        result: {
          tool: 'recents',
          toolCallId: 'tool-3',
          tag: '*',
          notes: [],
          error: 'Not a tag — omit the tag to list all recent notes.',
        },
      },
      {
        type: 'tool-call',
        call: { tool: 'dailies', toolCallId: 'tool-2', start: '2026-06-01', end: '2026-06-11' },
      },
      {
        type: 'tool-result',
        result: {
          tool: 'dailies',
          toolCallId: 'tool-2',
          start: '2026-06-01',
          end: '2026-06-11',
          days: [
            { path: 'daily/2026-06-10.md', title: '2026-06-10' },
            { path: 'daily/2026-06-09.md', title: '2026-06-09' },
          ],
        },
      },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Done.' }] },
    ])
    const view = renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'what have I been reading?{Enter}')

    await userEvent.click(await view.findByRole('button', { name: '#book' }))
    expect(probedRoute).toEqual({ kind: 'allNotes', tag: 'book' })
    await userEvent.click(view.getByRole('button', { name: 'Atlas' }))
    expect(probedRoute).toEqual({ kind: 'note', path: 'notes/atlas.md' })
    // A refused listing shows the refusal, not a misleading count.
    await view.findByText(/Listed #\* notes — Not a tag/)
    await view.findByText(/Listed daily notes 2026-06-01 – 2026-06-11 · 2 days/)
    await userEvent.click(view.getByRole('button', { name: '2026-06-10' }))
    expect(probedRoute).toEqual({ kind: 'daily', date: '2026-06-10' })
  })

  it('renders an attachment chip: filenames, with per-asset refusals inline', async () => {
    configureModel()
    scriptTurn([
      {
        type: 'tool-call',
        call: {
          tool: 'assets',
          toolCallId: 'tool-1',
          paths: ['assets/chart.png', 'assets/scan.pdf'],
        },
      },
      {
        type: 'tool-result',
        result: {
          tool: 'assets',
          toolCallId: 'tool-1',
          assets: [
            { path: 'assets/chart.png', error: null },
            { path: 'assets/scan.pdf', error: 'This asset cannot be read by AI.' },
          ],
        },
      },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Done.' }] },
    ])
    const view = renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'what does the chart show?{Enter}')

    // Entries are labeled by filename; a refused asset keeps its refusal inline.
    await view.findByText('chart.png')
    await view.findByText(/scan\.pdf — This asset cannot be read by AI\./)
  })

  it('renders streaming text as plain text until the turn settles', async () => {
    configureModel()
    streamChat.mockImplementation(() =>
      (async function* (): AsyncGenerator<ChatStreamEvent> {
        yield { type: 'text-delta', text: 'Streaming **markdown**' }
        await new Promise<never>(() => {})
      })(),
    )
    const view = renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')

    // Visible immediately as plain text — never re-parsed per delta.
    await view.findByText('Streaming **markdown**')
    expect(view.queryByTestId('markdown-preview')).toBeNull()
  })

  it('rejects a second send fired before the first one has rendered', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'One.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'One.' }] },
    ])
    const view = renderChat()
    if (!probedSend) {
      expect.unreachable('probe did not capture send')
    }
    const send = probedSend

    // Two sends in one tick — rendered state (and refs synced to it) still
    // says idle for both, so the guard must be synchronous.
    await act(async () => {
      await Promise.all([send('one'), send('two')])
    })

    expect(streamChat).toHaveBeenCalledTimes(1)
    expect(view.getByText('one')).toBeDefined()
    expect(view.queryByText('two')).toBeNull()
  })

  it('surfaces a missing keychain entry as an in-transcript error', async () => {
    configureModel()
    getSecret.mockResolvedValueOnce(null)
    const view = renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')
    await view.findByText(/No API key found for this provider/)
    expect(streamChat).not.toHaveBeenCalled()
  })

  it('aborts an in-flight turn when the provider unmounts (graph switch)', async () => {
    configureModel()
    let signal: AbortSignal | undefined
    streamChat.mockImplementation((options) => {
      signal = options.signal
      return (async function* (): AsyncGenerator<ChatStreamEvent> {
        yield { type: 'text-delta', text: 'Hi' }
        // Never settles — the turn only ends through the abort signal.
        await new Promise<never>(() => {})
      })()
    })
    const view = renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hey{Enter}')
    await waitFor(() => expect(signal).toBeDefined())
    expect(signal?.aborted).toBe(false)

    // Switching graphs remounts the workspace tree: the dead conversation
    // must not keep reading whichever graph is open now.
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('sends a dropped photo with no text as an image-only message', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'A cat.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'A cat.' }] },
    ])
    const view = renderChat()

    // Dropped on the textarea, handled by the screen-level drop target.
    fireEvent.drop(view.getByLabelText('Chat message'), {
      dataTransfer: { files: [pngFile('cat.png')], types: ['Files'] },
    })
    await view.findByRole('button', { name: 'Remove cat.png' })

    await userEvent.type(view.getByLabelText('Chat message'), '{Enter}')

    await waitFor(() => expect(streamChat).toHaveBeenCalled())
    expect(streamChat.mock.lastCall?.[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'image', image: 'data:image/png;base64,iVBORw==', mediaType: 'image/png' },
      ],
    })
    // The queue cleared; the photo now lives in the transcript bubble.
    expect(view.queryByRole('button', { name: 'Remove cat.png' })).toBeNull()
    expect(view.getByAltText('cat.png')).toBeDefined()
  })

  it('a drop still reading when New chat clears the session never lands', async () => {
    configureModel()
    const view = renderChat()

    // A file whose read only settles when the test says so.
    let releaseRead: (buffer: ArrayBuffer) => void = () => {}
    const file = pngFile('cat.png')
    Object.defineProperty(file, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          releaseRead = resolve
        }),
    })
    fireEvent.drop(view.getByLabelText('Chat message'), {
      dataTransfer: { files: [file], types: ['Files'] },
    })

    await act(async () => {
      probedNewChat?.()
    })
    await act(async () => {
      releaseRead(new Uint8Array([0x89]).buffer)
    })

    expect(view.queryByAltText('cat.png')).toBeNull()
  })

  it('claims non-image file drops so the webview never navigates to them', () => {
    configureModel()
    const view = renderChat()

    const notCancelled = fireEvent.drop(view.getByLabelText('Chat message'), {
      dataTransfer: {
        files: [new File(['hi'], 'notes.txt', { type: 'text/plain' })],
        types: ['Files'],
      },
    })

    // fireEvent returns false when a handler called preventDefault.
    expect(notCancelled).toBe(false)
    expect(view.queryByAltText('notes.txt')).toBeNull()
  })

  it('a removed attachment never sends', async () => {
    configureModel()
    const view = renderChat()

    fireEvent.drop(view.getByLabelText('Chat message'), {
      dataTransfer: { files: [pngFile('cat.png')], types: ['Files'] },
    })
    await userEvent.click(await view.findByRole('button', { name: 'Remove cat.png' }))
    expect(view.queryByAltText('cat.png')).toBeNull()

    // Nothing left to send: Enter on the empty composer is a no-op again.
    await userEvent.type(view.getByLabelText('Chat message'), '{Enter}')
    expect(streamChat).not.toHaveBeenCalled()
  })

  it('New chat clears the conversation', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'Hello!' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Hello!' }] },
    ])
    const view = renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hey{Enter}')
    await waitFor(() =>
      expect(view.getByTestId('markdown-preview').textContent).toContain('Hello!'),
    )

    await userEvent.click(view.getByRole('button', { name: /new chat/i }))
    expect(view.queryByTestId('markdown-preview')).toBeNull()
    expect(view.queryByText('hey')).toBeNull()
  })
})
