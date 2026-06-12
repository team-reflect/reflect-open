import { act, cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { AiModelConfig, ChatStreamEvent, StreamChatOptions } from '@reflect/core'
import { ChatProvider, useChatSession } from '@/providers/chat-provider'
import { RouterProvider } from '@/routing/router'

/**
 * The chat view over a faked engine: the provider stack and screen are real,
 * `streamChat` is scripted. Covers the no-model call-to-action, a full
 * grounded turn (user bubble → tool chip → cited answer), the
 * plain-while-streaming text rendering, abort-on-unmount, and New chat.
 */

const streamChat = vi.hoisted(() =>
  vi.fn<(options: StreamChatOptions) => AsyncGenerator<ChatStreamEvent>>(),
)
const getSecret = vi.hoisted(() => vi.fn<(name: string) => Promise<string | null>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  streamChat,
  getSecret,
}))

const settingsState = vi.hoisted(() => ({
  models: [] as AiModelConfig[],
  defaultId: null as string | null,
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { aiModels: settingsState.models, defaultAiModelId: settingsState.defaultId },
    updateSettings: () => {},
  }),
}))

// jsdom can't host the ProseMirror contenteditable (same stub as the palette
// tests); markdown rendering is the editor's concern, not this screen's.
vi.mock('@/editor/markdown-preview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => (
    <div data-testid="markdown-preview">{content}</div>
  ),
}))
vi.mock('@/lib/provider-fetch', () => ({ providerFetch: vi.fn() }))

const { ChatScreen } = await import('./chat-screen')

afterEach(cleanup)

beforeEach(() => {
  settingsState.models = []
  settingsState.defaultId = null
  streamChat.mockReset()
  getSecret.mockReset().mockResolvedValue('sk-test')
})

const MODEL: AiModelConfig = { id: 'm1', provider: 'openai', model: 'gpt-5.1', keyHint: '12345' }

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

let probedSend: ((text: string) => Promise<void>) | null = null

function SendProbe(): ReactElement | null {
  probedSend = useChatSession().send
  return null
}

function renderChat() {
  probedSend = null
  return render(
    <RouterProvider>
      <ChatProvider>
        <ChatScreen />
        <SendProbe />
      </ChatProvider>
    </RouterProvider>,
  )
}

describe('ChatScreen', () => {
  it('shows the add-a-model call to action when nothing is configured', () => {
    const view = renderChat()
    expect(view.getByRole('button', { name: /add an ai model/i })).toBeDefined()
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

    // The turn went out with the keychain key and the full derived history.
    expect(getSecret).toHaveBeenCalledWith('ai-api-key:m1')
    const options = streamChat.mock.lastCall?.[0]
    expect(options?.model).toEqual(MODEL)
    expect(options?.messages.at(-1)).toEqual({ role: 'user', content: 'when does atlas ship?' })
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
    await view.findByText(/No API key found for this model/)
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
