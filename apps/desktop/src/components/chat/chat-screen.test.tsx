import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
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
import { ChatScreen } from './chat-screen'

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
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  streamChat,
  getSecret,
  resolveWikiTarget,
  loadChatGraphContext,
}))
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openRouteInNewWindow,
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
          chatSystemPrompt: '',
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
    onWikiLinkClick?: (target: string, event?: MouseEvent | KeyboardEvent) => void
  }) => {
    const wikiTargets = Array.from(content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)).map(
      (match) => match[1]!,
    )
    return (
      <div data-testid="markdown-preview">
        {content}
        {wikiTargets.map((target) => (
          <button
            key={target}
            type="button"
            onClick={(event) => onWikiLinkClick?.(target, event.nativeEvent)}
          >
            Open {target}
          </button>
        ))}
      </div>
    )
  },
}))
vi.mock('@/lib/provider-fetch', () => ({ providerFetch: vi.fn() }))

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
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
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

/** Dispatches a real drop with the files loaded into a real `DataTransfer`. */
function dropFiles(target: Element, files: File[]): boolean {
  const dataTransfer = new DataTransfer()
  for (const file of files) {
    dataTransfer.items.add(file)
  }
  return target.dispatchEvent(
    new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }),
  )
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
  it('shows the add-a-provider call to action when nothing is configured', async () => {
    const view = await renderChat()
    await expect
      .element(view.getByRole('button', { name: /add an ai provider/i }))
      .toBeInTheDocument()
    expect(view.getByLabelText('Chat message').query()).toBeNull()
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
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'when does atlas ship?{Enter}')

    await expect.element(view.getByText('when does atlas ship?')).toBeInTheDocument()
    await expect.element(view.getByText(/Searched “atlas” · 1 note/)).toBeInTheDocument()
    // The turn settled, so the answer renders as markdown (not plain text).
    await expect.element(view.getByTestId('markdown-preview')).toHaveTextContent('It ships in June.')
    await view.getByRole('button', { name: 'Atlas', exact: true }).click()
    expect(probedRoute).toEqual({ kind: 'note', path: 'notes/atlas.md' })

    // The turn went out with the keychain key and the full derived history.
    expect(getSecret).toHaveBeenCalledWith('ai-api-key:m1')
    const options = streamChat.mock.lastCall?.[0]
    expect(options?.config).toEqual(MODEL)
    expect(options?.messages.at(-1)).toEqual({ role: 'user', content: 'when does atlas ship?' })
  })

  it('opens ⌘-clicked tool-result and read-note links in new windows', async () => {
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
      {
        type: 'tool-call',
        call: { tool: 'read', toolCallId: 'tool-2', paths: ['notes/brief.md'] },
      },
      {
        type: 'tool-result',
        result: {
          tool: 'read',
          toolCallId: 'tool-2',
          notes: [{ path: 'notes/brief.md', title: 'Brief', error: null }],
        },
      },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Done.' }] },
    ])
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'open the source notes{Enter}')
    await view.getByRole('button', { name: 'Atlas', exact: true }).click({ modifiers: ['Meta'] })
    await view.getByRole('button', { name: 'Brief', exact: true }).click({ modifiers: ['Meta'] })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow.mock.calls).toEqual([
        [{ kind: 'note', path: 'notes/atlas.md' }],
        [{ kind: 'note', path: 'notes/brief.md' }],
      ]),
    )
    expect(probedRoute).toEqual({ kind: 'today' })
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
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'what should I open?{Enter}')
    await view.getByRole('button', { name: 'Open Atlas' }).click()

    await vi.waitFor(() => expect(probedRoute).toEqual({ kind: 'note', path: 'notes/atlas.md' }))
  })

  it('opens ⌘-clicked cited wiki links in a new window', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'See [[Atlas]].' },
      {
        type: 'complete',
        messages: [{ role: 'assistant', content: 'See [[Atlas]].' }],
      },
    ])
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'what should I open?{Enter}')
    await view.getByRole('button', { name: 'Open Atlas' }).click({ modifiers: ['Meta'] })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/atlas.md',
      }),
    )
    expect(probedRoute).toEqual({ kind: 'today' })
  })

  it('offers the provider catalog in the picker, keeping a custom model selectable', async () => {
    configureModel()
    const view = await renderChat()

    // Options render in a portal, so they're queried from the page.
    await view.getByRole('combobox', { name: 'Model' }).click()

    await expect.element(page.getByText('OpenAI')).toBeInTheDocument()
    const labels = page
      .getByRole('option')
      .elements()
      .map((option) => option.textContent)
    // The full curated catalog plus the entry's custom configured model.
    expect(labels).toEqual([
      'GPT-5.6 Sol',
      'GPT-5.6 Terra',
      'GPT-5.6 Luna',
      'GPT-5.5',
      'GPT-5.4',
      'GPT-5.4 mini',
      'GPT-5.4 nano',
      'gpt-5.1',
    ])
  })

  it('routes the turn to the picked catalog model', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'Hi.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] },
    ])
    const view = await renderChat()

    await view.getByRole('combobox', { name: 'Model' }).click()
    await page.getByRole('option', { name: 'GPT-5.6 Terra' }).click()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')

    await vi.waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1))
    // Same entry (id → keychain key), with the picked model applied.
    expect(streamChat.mock.lastCall?.[0].config).toEqual({ ...MODEL, model: 'gpt-5.6-terra' })
  })

  it('starts the picker on the model persisted from the last session', async () => {
    configureModel()
    settingsState.selection = { configId: 'm1', modelId: 'gpt-5.6-luna' }
    const view = await renderChat()

    await view.getByRole('combobox', { name: 'Model' }).click()

    const picked = page.getByRole('option', { name: 'GPT-5.6 Luna' })
    await expect.element(picked).toHaveAttribute('aria-selected', 'true')
  })

  it('sends the graph overview context with each turn', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'Hi.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] },
    ])
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')

    await vi.waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1))
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
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')

    await vi.waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1))
    expect(streamChat.mock.lastCall?.[0].context).toBeNull()
    await expect.element(view.getByText('Hi.')).toBeInTheDocument()
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
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'what have I been reading?{Enter}')

    await view.getByRole('button', { name: '#book' }).click()
    expect(probedRoute).toEqual({ kind: 'allNotes', tag: 'book' })
    await view.getByRole('button', { name: 'Atlas', exact: true }).click()
    expect(probedRoute).toEqual({ kind: 'note', path: 'notes/atlas.md' })
    // A refused listing shows the refusal, not a misleading count.
    await expect.element(view.getByText(/Listed #\* notes — Not a tag/)).toBeInTheDocument()
    await expect
      .element(view.getByText(/Listed daily notes 2026-06-01 – 2026-06-11 · 2 days/))
      .toBeInTheDocument()
    await view.getByRole('button', { name: '2026-06-10' }).click()
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
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'what does the chart show?{Enter}')

    // Entries are labeled by filename; a refused asset keeps its refusal inline.
    await expect.element(view.getByText('chart.png')).toBeInTheDocument()
    await expect
      .element(view.getByText(/scan\.pdf — This asset cannot be read by AI\./))
      .toBeInTheDocument()
  })

  it('renders streaming text as plain text until the turn settles', async () => {
    configureModel()
    streamChat.mockImplementation(() =>
      (async function* (): AsyncGenerator<ChatStreamEvent> {
        yield { type: 'text-delta', text: 'Streaming **markdown**' }
        await new Promise<never>(() => {})
      })(),
    )
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')

    // Visible immediately as plain text — never re-parsed per delta.
    await expect.element(view.getByText('Streaming **markdown**')).toBeInTheDocument()
    expect(view.getByTestId('markdown-preview').query()).toBeNull()
  })

  it('rejects a second send fired before the first one has rendered', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'One.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'One.' }] },
    ])
    const view = await renderChat()
    if (!probedSend) {
      expect.unreachable('probe did not capture send')
    }
    const send = probedSend

    // Two sends in one tick — rendered state (and refs synced to it) still
    // says idle for both, so the guard must be synchronous.
    await Promise.all([send('one'), send('two')])

    expect(streamChat).toHaveBeenCalledTimes(1)
    // Exact match: the assistant's reply ("One.") also contains this text.
    await expect.element(view.getByText('one', { exact: true })).toBeInTheDocument()
    expect(view.getByText('two', { exact: true }).query()).toBeNull()
  })

  it('surfaces a missing keychain entry as an in-transcript error', async () => {
    configureModel()
    getSecret.mockResolvedValueOnce(null)
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')
    await expect.element(view.getByText(/No API key found for this provider/)).toBeInTheDocument()
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
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hey{Enter}')
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(signal?.aborted).toBe(false)

    // Switching graphs remounts the workspace tree: the dead conversation
    // must not keep reading whichever graph is open now.
    await view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('sends a dropped photo with no text as an image-only message', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'A cat.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'A cat.' }] },
    ])
    const view = await renderChat()

    // Dropped on the textarea, handled by the screen-level drop target.
    dropFiles(view.getByLabelText('Chat message').element(), [pngFile('cat.png')])
    await expect.element(view.getByRole('button', { name: 'Remove cat.png' })).toBeInTheDocument()

    await userEvent.type(view.getByLabelText('Chat message'), '{Enter}')

    await vi.waitFor(() => expect(streamChat).toHaveBeenCalled())
    expect(streamChat.mock.lastCall?.[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'image', image: 'data:image/png;base64,iVBORw==', mediaType: 'image/png' },
      ],
    })
    // The queue cleared; the photo now lives in the transcript bubble.
    expect(view.getByRole('button', { name: 'Remove cat.png' }).query()).toBeNull()
    await expect.element(view.getByAltText('cat.png')).toBeInTheDocument()
  })

  it('a drop still reading when New chat clears the session never lands', async () => {
    configureModel()
    const view = await renderChat()

    // A file whose read only settles when the test says so.
    let releaseRead: (buffer: ArrayBuffer) => void = () => {}
    const file = pngFile('cat.png')
    Object.defineProperty(file, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          releaseRead = resolve
        }),
    })
    dropFiles(view.getByLabelText('Chat message').element(), [file])

    probedNewChat?.()
    releaseRead(new Uint8Array([0x89]).buffer)
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(view.getByAltText('cat.png').query()).toBeNull()
  })

  it('claims non-image file drops so the webview never navigates to them', async () => {
    configureModel()
    const view = await renderChat()

    const notCancelled = dropFiles(view.getByLabelText('Chat message').element(), [
      new File(['hi'], 'notes.txt', { type: 'text/plain' }),
    ])

    // dispatchEvent returns false when a handler called preventDefault.
    expect(notCancelled).toBe(false)
    expect(view.getByAltText('notes.txt').query()).toBeNull()
  })

  it('a removed attachment never sends', async () => {
    configureModel()
    const view = await renderChat()

    dropFiles(view.getByLabelText('Chat message').element(), [pngFile('cat.png')])
    await view.getByRole('button', { name: 'Remove cat.png' }).click()
    expect(view.getByAltText('cat.png').query()).toBeNull()

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
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hey{Enter}')
    await expect.element(view.getByTestId('markdown-preview')).toHaveTextContent('Hello!')

    await view.getByRole('button', { name: /new chat/i }).click()
    expect(view.getByTestId('markdown-preview').query()).toBeNull()
    expect(view.getByText('hey').query()).toBeNull()
  })
})
