import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import type {
  AiProviderConfig,
  ChatModelSelection,
  ChatStreamEvent,
  Settings,
  StreamChatOptions,
} from '@reflect/core'
import { ChatProvider } from '@/providers/chat-provider'
import { RouterProvider, useRouter } from '@/routing/router'

/**
 * The Chat tab over a faked engine (the desktop chat-screen harness, mobile
 * shell): the no-provider call-to-action into Settings, a full send through
 * the mobile composer, and the Plan 23 contract that the draft and turns
 * survive the screen unmounting — the provider holds them, tab switches only
 * unmount the screen.
 */

const streamChat = vi.hoisted(() =>
  vi.fn<(options: StreamChatOptions) => AsyncGenerator<ChatStreamEvent>>(),
)
const getSecret = vi.hoisted(() => vi.fn<(name: string) => Promise<string | null>>())
const loadChatGraphContext = vi.hoisted(() => vi.fn<(graphName: string) => Promise<null>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  streamChat,
  getSecret,
  loadChatGraphContext,
}))

const settingsState = vi.hoisted(() => ({
  models: [] as AiProviderConfig[],
  defaultId: null as string | null,
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      aiProviders: settingsState.models,
      defaultAiProviderId: settingsState.defaultId,
      chatModelSelection: null as ChatModelSelection | null,
      chatSystemPrompt: '',
    },
    updateSettings: (_patch: Partial<Settings>) => {},
  }),
}))

// No open index → persistence stays inert; chat-provider.test.tsx covers it.
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ indexGeneration: null, graph: null }),
}))

// jsdom can't host the ProseMirror contenteditable; settled markdown renders
// as plain text here.
vi.mock('@/editor/markdown-preview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => (
    <div data-testid="markdown-preview">{content}</div>
  ),
}))
vi.mock('@/lib/provider-fetch', () => ({ providerFetch: vi.fn() }))

// vaul needs browser APIs jsdom doesn't provide; passthrough so sheet content
// renders inline.
vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

// shadcn's MessageScroller drives the viewport with scrollTo; jsdom has no
// layout engine.
Element.prototype.scrollTo ??= () => {}

const { MobileChat } = await import('./chat')

afterEach(cleanup)

const MODEL: AiProviderConfig = { id: 'm1', provider: 'openai', model: 'gpt-5.1', keyHint: '12345' }

beforeEach(() => {
  settingsState.models = []
  settingsState.defaultId = null
  streamChat.mockReset()
  getSecret.mockReset().mockResolvedValue('sk-test')
  loadChatGraphContext.mockReset().mockResolvedValue(null)
})

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

let probedRoute: unknown = null

function RouteProbe(): null {
  probedRoute = useRouter().route
  return null
}

function FocusChatProbe(): ReactElement {
  const { navigate } = useRouter()
  return (
    <button type="button" onClick={() => navigate({ kind: 'chat' }, { focusEditor: true })}>
      focus chat input
    </button>
  )
}

/** The screen inside the real provider stack, unmountable like a tab switch. */
function Harness({ showScreen }: { showScreen: boolean }): ReactElement {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider>
        <RouteProbe />
        <FocusChatProbe />
        <ChatProvider graph={{ root: '/graphs/test', name: 'test-graph', generation: 1 }}>
          {showScreen ? <MobileChat /> : null}
        </ChatProvider>
      </RouterProvider>
    </QueryClientProvider>
  )
}

describe('MobileChat', () => {
  it('with no provider, the call-to-action navigates to Settings', () => {
    render(<Harness showScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Add an AI provider' }))

    expect(probedRoute).toEqual({ kind: 'settings' })
  })

  it('sends the draft from the composer and renders the streamed turn', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'Grounded answer.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Grounded answer.' }] },
    ])
    render(<Harness showScreen />)

    const composer = screen.getByLabelText('Chat message')
    fireEvent.change(composer, { target: { value: 'what did I write?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByText('Grounded answer.')).toBeDefined())
    expect(screen.getByText('what did I write?')).toBeDefined()
    // A send that goes through clears the provider-held draft.
    expect((composer as HTMLTextAreaElement).value).toBe('')
  })

  it('keeps the draft and the conversation across a screen unmount (tab switch)', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'Kept.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Kept.' }] },
    ])
    const { rerender } = render(<Harness showScreen />)

    fireEvent.change(screen.getByLabelText('Chat message'), {
      target: { value: 'sent question' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByText('Kept.')).toBeDefined())

    fireEvent.change(screen.getByLabelText('Chat message'), {
      target: { value: 'half-typed follow-up' },
    })

    rerender(<Harness showScreen={false} />)
    expect(screen.queryByLabelText('Chat message')).toBeNull()
    rerender(<Harness showScreen />)

    expect((screen.getByLabelText('Chat message') as HTMLTextAreaElement).value).toBe(
      'half-typed follow-up',
    )
    expect(screen.getByText('sent question')).toBeDefined()
  })

  it('focuses the composer when a chat tab capture arrival requests it', async () => {
    configureModel()
    render(<Harness showScreen />)

    const composer = screen.getByLabelText('Chat message')
    fireEvent.click(screen.getByRole('button', { name: 'focus chat input' }))

    await waitFor(() => expect(document.activeElement).toBe(composer))
  })
})
