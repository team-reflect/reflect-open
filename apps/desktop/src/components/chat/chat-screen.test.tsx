import { createTestWindowService, type TestWindowService } from '@reflect/app/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { createRef, useLayoutEffect, type ReactElement, type RefObject } from 'react'
import {
  aiKeySecretName,
  aiProvider,
  type AiProviderConfig,
  type ChatModelSelection,
  type ChatStreamEvent,
  type CloudGraphContext,
} from '@reflect/core'
import {
  createTestCoreServices,
  createTestChatEngineService,
  createTestChatGraphContextService,
  createTestSecretStoreService,
  seedNotes,
  type TestChatEngineService,
  type TestChatGraphContextService,
  type TestOpenGraph,
} from '@reflect/core/testing'
import { useChatSession, type ChatContextValue } from '@/providers/chat-provider.tsx'
import { useRouter } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { ChatScreen } from './chat-screen.tsx'
import { deepLinkForRoute, type Route } from '@reflect/app'

/**
 * The chat view over a faked engine: the provider stack, the chat session and
 * the screen are real, the engine's turns are scripted. Covers the
 * no-provider call-to-action, a full grounded turn (user bubble → tool chip →
 * cited answer), the model picker, live markdown rendering,
 * abort on a graph switch, New chat, and photo attachments (drop → preview →
 * image-only send).
 */

// The settings document and the keychain each test starts from.
const settingsState = {
  models: [] as AiProviderConfig[],
  defaultId: null as string | null,
  selection: null as ChatModelSelection | null,
  apiKey: 'sk-test' as string | null,
}

const GRAPH: TestOpenGraph = { root: '/graphs/test', name: 'test-graph', generation: 1 }

const GRAPH_CONTEXT: CloudGraphContext = {
  graphName: 'test-graph',
  noteCount: 3,
  dailyNoteCount: 1,
  earliestDailyDate: '2026-06-01',
  latestDailyDate: '2026-06-01',
  tags: [{ tag: 'book', count: 2 }],
  tagsTruncated: false,
}

let chatEngine: TestChatEngineService
let chatGraphContext: TestChatGraphContextService
let noteWindows: TestWindowService

beforeEach(() => {
  settingsState.models = []
  settingsState.defaultId = null
  settingsState.selection = null
  settingsState.apiKey = 'sk-test'
  chatEngine = createTestChatEngineService()
  chatGraphContext = createTestChatGraphContextService(GRAPH_CONTEXT)
})

const MODEL: AiProviderConfig = { id: 'm1', provider: 'openai', model: 'gpt-5.1', keyHint: '12345' }

function configureModel() {
  settingsState.models = [MODEL]
  settingsState.defaultId = 'm1'
}

function scriptTurn(events: ChatStreamEvent[]) {
  chatEngine.setScript(events)
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

const probedSendRef: RefObject<ChatContextValue['send'] | null> = createRef()
const probedNewChatRef: RefObject<ChatContextValue['newChat'] | null> = createRef()
const probedRouteRef: RefObject<Route | null> = createRef()

function SendProbe(): ReactElement | null {
  const { send, newChat } = useChatSession()

  useLayoutEffect(() => {
    probedSendRef.current = send
    return () => {
      probedSendRef.current = null
    }
  }, [send])

  useLayoutEffect(() => {
    probedNewChatRef.current = newChat
    return () => {
      probedNewChatRef.current = null
    }
  }, [newChat])

  return null
}

function RouteProbe(): ReactElement | null {
  const { route } = useRouter()

  useLayoutEffect(() => {
    probedRouteRef.current = route
    return () => {
      probedRouteRef.current = null
    }
  }, [route])

  return null
}

async function renderChat() {
  probedSendRef.current = null
  probedRouteRef.current = null
  const core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    secretStore: createTestSecretStoreService(
      settingsState.apiKey === null ? {} : { [aiKeySecretName(MODEL.id)]: settingsState.apiKey },
    ),
    chatEngine,
    chatGraphContext,
  })
  // The cited `[[Atlas]]` links resolve through the index.
  seedNotes(core.database, [{ path: 'notes/atlas.md', markdown: '# Atlas\n' }])
  noteWindows = createTestWindowService()
  return await renderInApp(
    <>
      <ChatScreen />
      <SendProbe />
      <RouteProbe />
    </>,
    {
      core,
      appServices: { window: noteWindows },
      graph: GRAPH,
      settings: {
        aiProviders: settingsState.models,
        defaultAiProviderId: settingsState.defaultId,
        chatModelSelection: settingsState.selection,
      },
    },
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
      {
        type: 'complete',
        messages: [{ role: 'assistant', content: 'It ships in June. [[Atlas]]' }],
      },
    ])
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'when does atlas ship?{Enter}')

    await expect.element(view.getByText('when does atlas ship?')).toBeInTheDocument()
    await expect.element(view.getByText(/Searched “atlas” · 1 note/)).toBeInTheDocument()
    await expect.element(view.getByText('It ships in June.')).toBeInTheDocument()
    await view.getByRole('button', { name: 'Atlas', exact: true }).click()
    expect(probedRouteRef.current).toEqual({ kind: 'note', path: 'notes/atlas.md' })

    // The turn went out with the keychain key and the full derived history.
    const options = chatEngine.calls().at(-1)
    expect(options?.apiKey).toBe('sk-test')
    expect(options?.config).toEqual(MODEL)
    expect(options?.messages.at(-1)).toEqual({ role: 'user', content: 'when does atlas ship?' })
  })

  it('copies a settled reply as the markdown the model wrote', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'It ships in June. [[Atlas]]' },
      {
        type: 'complete',
        messages: [{ role: 'assistant', content: 'It ships in June. [[Atlas]]' }],
      },
    ])
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'when does atlas ship?{Enter}')
    const copyButton = view.getByRole('button', { name: 'Copy reply' })
    const copyFooter = copyButton.element().closest('[data-slot="message-footer"]')
    if (!(copyFooter instanceof HTMLElement)) {
      expect.unreachable('copy button did not render in a message footer')
    }

    expect(getComputedStyle(copyFooter).opacity).toBe('0')
    expect(getComputedStyle(copyFooter).pointerEvents).toBe('none')
    expect(getComputedStyle(copyButton.element()).pointerEvents).toBe('none')
    expect(getComputedStyle(copyButton.element()).width).toBe('20px')
    expect(copyFooter.parentElement?.classList.contains('group/assistant-response')).toBe(true)
    expect(copyFooter.classList.contains('group-hover/assistant-response:opacity-100')).toBe(true)

    // The browser suite emulates touch, where hover media queries stay off;
    // keyboard focus exercises the equivalent accessible reveal path.
    copyButton.element().focus()
    await vi.waitFor(() => {
      expect(getComputedStyle(copyFooter).opacity).toBe('1')
      expect(getComputedStyle(copyFooter).pointerEvents).toBe('auto')
      expect(getComputedStyle(copyButton.element()).pointerEvents).toBe('auto')
    })
    await copyButton.click()

    // The wiki link survives the copy, so a pasted reply still links.
    expect(writeText).toHaveBeenCalledWith('It ships in June. [[Atlas]]')
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
    await view
      .getByRole('button', { name: 'Atlas', exact: true })
      .click({ modifiers: ['ControlOrMeta'] })
    await view
      .getByRole('button', { name: 'Brief', exact: true })
      .click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() => {
      expect(noteWindows.openedNoteWindows()).toEqual([
        deepLinkForRoute({ kind: 'note', path: 'notes/atlas.md' }),
        deepLinkForRoute({ kind: 'note', path: 'notes/brief.md' }),
      ])
    })
    expect(probedRouteRef.current).toEqual({ kind: 'today' })
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
    await view.getByTestId('wikilink').click()

    await vi.waitFor(() => {
      expect(probedRouteRef.current).toEqual({ kind: 'note', path: 'notes/atlas.md' })
    })
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
    await view.getByTestId('wikilink').click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() => {
      expect(noteWindows.openedNoteWindows()).toContain(
        deepLinkForRoute({
          kind: 'note',
          path: 'notes/atlas.md',
        }),
      )
    })
    expect(probedRouteRef.current).toEqual({ kind: 'today' })
  })

  it('offers the provider catalog in the picker, keeping a custom model selectable', async () => {
    configureModel()
    const view = await renderChat()

    // Options render in a portal, so they're queried from the page.
    await view.getByRole('combobox', { name: 'Model' }).click()

    await expect.element(page.getByText('OpenAI')).toBeInTheDocument()
    await expect
      .poll(() => {
        return page
          .getByRole('option')
          .elements()
          .map((option) => option.textContent)
      })
      .toEqual([...aiProvider('openai').models.map((model) => model.label), MODEL.model])
  })

  it('routes the turn to the picked catalog model', async () => {
    configureModel()
    const pick = aiProvider('openai').models[1]!
    scriptTurn([
      { type: 'text-delta', text: 'Hi.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] },
    ])
    const view = await renderChat()

    await view.getByRole('combobox', { name: 'Model' }).click()
    await page.getByRole('option', { name: pick.label }).click()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')

    await vi.waitFor(() => expect(chatEngine.calls()).toHaveLength(1))
    // Same entry (id → keychain key), with the picked model applied.
    expect(chatEngine.calls().at(-1)?.config).toEqual({ ...MODEL, model: pick.id })
  })

  it('starts the picker on the model persisted from the last session', async () => {
    configureModel()
    const pick = aiProvider('openai').models[2]!
    settingsState.selection = { configId: 'm1', modelId: pick.id }
    const view = await renderChat()

    await view.getByRole('combobox', { name: 'Model' }).click()

    const picked = page.getByRole('option', { name: pick.label })
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

    await vi.waitFor(() => expect(chatEngine.calls()).toHaveLength(1))
    expect(chatGraphContext.calls()).toEqual(['test-graph'])
    expect(chatEngine.calls().at(-1)?.context).toEqual(GRAPH_CONTEXT)
  })

  it('still sends the turn, without an overview, when the context load fails', async () => {
    configureModel()
    chatGraphContext.setResult(() => {
      throw new Error('index not open')
    })
    scriptTurn([
      { type: 'text-delta', text: 'Hi.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] },
    ])
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')

    await vi.waitFor(() => expect(chatEngine.calls()).toHaveLength(1))
    expect(chatEngine.calls().at(-1)?.context).toBeNull()
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
    expect(probedRouteRef.current).toEqual({ kind: 'allNotes', tag: 'book' })
    await view.getByRole('button', { name: 'Atlas', exact: true }).click()
    expect(probedRouteRef.current).toEqual({ kind: 'note', path: 'notes/atlas.md' })
    // A refused listing shows the refusal, not a misleading count.
    await expect.element(view.getByText(/Listed #\* notes — Not a tag/)).toBeInTheDocument()
    await expect
      .element(view.getByText(/Listed daily notes 6\/1\/2026 – 6\/11\/2026 · 2 days/))
      .toBeInTheDocument()
    await view.getByRole('button', { name: 'Wed, June 10th, 2026' }).click()
    expect(probedRouteRef.current).toEqual({ kind: 'daily', date: '2026-06-10' })
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

  it('renders markdown as chunks arrive and keeps it mounted when the turn settles', async () => {
    configureModel()
    const nextChunk = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const firstChunk = '# Streaming\n\n**markdown'
    const secondChunk = '**\n\n- First item\n- Second item\n\n```ts\nconst answer = 42'
    const finalChunk = '\n```\n\nSee [[Atlas]].'
    chatEngine.setScript(() => {
      return (async function* (): AsyncGenerator<ChatStreamEvent> {
        yield { type: 'text-delta', text: firstChunk }
        await nextChunk.promise
        yield { type: 'text-delta', text: secondChunk }
        await finish.promise
        yield { type: 'text-delta', text: finalChunk }
        yield {
          type: 'complete',
          messages: [{ role: 'assistant', content: firstChunk + secondChunk + finalChunk }],
        }
      })()
    })
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')

    const heading = view.getByRole('heading', { name: 'Streaming', level: 1 })
    await expect.element(heading).toBeInTheDocument()
    const headingElement = heading.element()
    await expect.element(view.getByText('**markdown', { exact: true })).toBeInTheDocument()
    expect(view.getByRole('button', { name: 'Copy reply' }).query()).toBeNull()

    nextChunk.resolve()
    const bold = view.getByRole('strong')
    await expect.element(bold).toMatchTextContent('markdown')
    const firstItem = view.getByText('First item', { exact: true })
    await expect.element(firstItem).toBeInTheDocument()
    expect(firstItem.element().closest('.prosemirror-flat-list')).not.toBeNull()
    await expect.element(view.getByText('Second item', { exact: true })).toBeInTheDocument()
    await expect.element(view.getByRole('code')).toMatchTextContent('const answer = 42')
    expect(view.getByRole('button', { name: 'Copy reply' }).query()).toBeNull()

    finish.resolve()
    await expect.element(view.getByRole('button', { name: 'Copy reply' })).toBeInTheDocument()
    await expect.element(view.getByTestId('wikilink')).toMatchTextContent('Atlas')
    expect(heading.element()).toBe(headingElement)
    expect(bold.element().tagName).toBe('STRONG')
    await expect.element(view.getByRole('code')).toMatchTextContent('const answer = 42')
  })

  it('rejects a second send fired before the first one has rendered', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'One.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'One.' }] },
    ])
    const view = await renderChat()
    if (!probedSendRef.current) {
      expect.unreachable('probe did not capture send')
    }
    const send = probedSendRef.current

    // Two sends in one tick — rendered state (and refs synced to it) still
    // says idle for both, so the guard must be synchronous.
    await Promise.all([send('one'), send('two')])

    expect(chatEngine.calls()).toHaveLength(1)
    // Exact match: the assistant's reply ("One.") also contains this text.
    await expect.element(view.getByText('one', { exact: true })).toBeInTheDocument()
    expect(view.getByText('two', { exact: true }).query()).toBeNull()
  })

  it('surfaces a missing keychain entry as an in-transcript error', async () => {
    configureModel()
    settingsState.apiKey = null
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hi{Enter}')
    await expect.element(view.getByText(/No API key found for this provider/)).toBeInTheDocument()
    expect(chatEngine.calls()).toEqual([])
  })

  it('aborts an in-flight turn when the graph session ends (graph switch)', async () => {
    configureModel()
    let signal: AbortSignal | undefined
    chatEngine.setScript((options) => {
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

    // The dead conversation must not keep reading whichever graph is open now.
    view.core.graphSession.setGraph({ root: '/graphs/other' })
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

    await vi.waitFor(() => expect(chatEngine.calls()).toHaveLength(1))
    expect(chatEngine.calls().at(-1)?.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'file', data: 'data:image/png;base64,iVBORw==', mediaType: 'image/png' }],
    })
    // The queue cleared; the photo now lives in the transcript bubble.
    expect(view.getByRole('button', { name: 'Remove cat.png' }).query()).toBeNull()
    await expect.element(view.getByAltText('cat.png')).toBeInTheDocument()
  })

  it('a drop still reading when New chat clears the session never lands', async () => {
    configureModel()
    const view = await renderChat()

    // A file whose read only settles when the test says so.
    const pendingRead = Promise.withResolvers<ArrayBuffer>()
    const file = pngFile('cat.png')
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => pendingRead.promise,
    })
    dropFiles(view.getByLabelText('Chat message').element(), [file])

    probedNewChatRef.current?.()
    pendingRead.resolve(new Uint8Array([0x89]).buffer)
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
    expect(chatEngine.calls()).toEqual([])
  })

  it('New chat clears the conversation', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'Hello!' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Hello!' }] },
    ])
    const view = await renderChat()

    await userEvent.type(view.getByLabelText('Chat message'), 'hey{Enter}')
    await expect.element(view.getByText('Hello!', { exact: true })).toBeInTheDocument()

    await view.getByRole('button', { name: /new chat/i }).click()
    expect(view.getByText('Hello!', { exact: true }).query()).toBeNull()
    expect(view.getByText('hey').query()).toBeNull()
  })
})
