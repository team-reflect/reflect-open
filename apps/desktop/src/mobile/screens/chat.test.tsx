import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
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
import { fireEvent } from '@/test-utils/fire-event'

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
const aiApiKeyForConfig = vi.hoisted(() =>
  vi.fn<(config: AiProviderConfig) => Promise<string | null>>(),
)
const loadChatGraphContext = vi.hoisted(() => vi.fn<(graphName: string) => Promise<null>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  streamChat,
  aiApiKeyForConfig,
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

// Keep settled markdown as plain text so this suite isolates the chat state.
vi.mock('@/editor/markdown-preview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => (
    <div data-testid="markdown-preview">{content}</div>
  ),
}))
vi.mock('@/lib/provider-fetch', () => ({ providerFetch: vi.fn() }))

// Keep sheet content inline so this suite isolates the chat flow.
vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

const { MobileChat } = await import('./chat')

afterEach(async () => {
  await cleanup()
})

const MODEL: AiProviderConfig = { id: 'm1', provider: 'openai', model: 'gpt-5.1', keyHint: '12345' }

beforeEach(() => {
  settingsState.models = []
  settingsState.defaultId = null
  streamChat.mockReset()
  aiApiKeyForConfig.mockReset().mockResolvedValue('sk-test')
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
  it('with no provider, the call-to-action navigates to Settings', async () => {
    await render(<Harness showScreen />)

    await page.getByRole('button', { name: 'Add an AI provider' }).click()

    expect(probedRoute).toEqual({ kind: 'settings' })
  })

  it('sends the draft from the composer and renders the streamed turn', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'Grounded answer.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Grounded answer.' }] },
    ])
    await render(<Harness showScreen />)

    const composer = page.getByLabelText('Chat message')
    fireEvent.change(composer, { target: { value: 'what did I write?' } })
    await page.getByRole('button', { name: 'Send' }).click()

    await expect.element(page.getByText('Grounded answer.')).toBeVisible()
    await expect.element(page.getByText('what did I write?')).toBeVisible()
    // A send that goes through clears the provider-held draft.
    await expect.element(composer).toHaveValue('')
  })

  it('keeps the draft and the conversation across a screen unmount (tab switch)', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'Kept.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Kept.' }] },
    ])
    const { rerender } = await render(<Harness showScreen />)

    fireEvent.change(page.getByLabelText('Chat message'), {
      target: { value: 'sent question' },
    })
    await page.getByRole('button', { name: 'Send' }).click()
    await expect.element(page.getByText('Kept.')).toBeVisible()

    fireEvent.change(page.getByLabelText('Chat message'), {
      target: { value: 'half-typed follow-up' },
    })

    await rerender(<Harness showScreen={false} />)
    await expect.element(page.getByLabelText('Chat message')).not.toBeInTheDocument()
    await rerender(<Harness showScreen />)

    await expect.element(page.getByLabelText('Chat message')).toHaveValue('half-typed follow-up')
    await expect.element(page.getByText('sent question')).toBeVisible()
  })

  it('focuses the composer when a chat tab capture arrival requests it', async () => {
    configureModel()
    await render(<Harness showScreen />)

    const composer = page.getByLabelText('Chat message')
    await page.getByRole('button', { name: 'focus chat input' }).click()

    await vi.waitFor(() => expect(document.activeElement).toBe(composer.element()))
  })

  it('opens an accessible permission drawer and selects Read & write', async () => {
    configureModel()
    await render(<Harness showScreen />)
    const trigger = page.getByRole('button', { name: 'Chat permissions, Read only' })

    await expect.element(trigger).toHaveTextContent('Read')
    await expect.element(trigger).toHaveAttribute('aria-expanded', 'false')
    await trigger.click()
    await expect.element(trigger).toHaveAttribute('aria-expanded', 'true')

    const group = page.getByRole('radiogroup', { name: 'Chat permissions' })
    const readOnly = group.getByRole('radio', { name: /Read only/ })
    await expect.element(readOnly).toBeChecked()
    await expect.element(page.getByText('Search and answer from your notes')).toBeVisible()
    await expect
      .element(page.getByText('Can edit non-private notes; changes are reviewable and undoable'))
      .toBeVisible()

    readOnly.element().focus()
    await userEvent.keyboard('{ArrowDown}')
    const writeTrigger = page.getByRole('button', { name: 'Chat permissions, Read & write' })
    await expect.element(writeTrigger).toHaveTextContent('Write')
    await expect.element(writeTrigger).toHaveAttribute('aria-expanded', 'true')
    await expect.element(group.getByRole('radio', { name: /Read & write/ })).toBeChecked()

    await userEvent.keyboard(' ')
    await expect.element(writeTrigger).toHaveAttribute('aria-expanded', 'false')
    await writeTrigger.click()
    await expect
      .element(
        page
          .getByRole('radiogroup', { name: 'Chat permissions' })
          .getByRole('radio', { name: /Read & write/ }),
      )
      .toBeChecked()
  })

  it('disables the permission trigger and drawer choices while chat is busy', async () => {
    configureModel()
    streamChat.mockImplementation(() =>
      (async function* (): AsyncGenerator<ChatStreamEvent> {
        yield { type: 'text-delta', text: 'Working…' }
        await new Promise<never>(() => {})
      })(),
    )
    await render(<Harness showScreen />)
    const trigger = page.getByRole('button', { name: /Chat permissions/ })
    await trigger.click()

    fireEvent.change(page.getByLabelText('Chat message'), { target: { value: 'keep working' } })
    await page.getByRole('button', { name: 'Send' }).click()
    await expect.element(page.getByText('Working…')).toBeVisible()

    await expect.element(trigger).toBeDisabled()
    const modelTrigger = page.getByRole('button', { name: 'Model' })
    await expect.element(modelTrigger).toBeDisabled()
    await expect.element(modelTrigger).toHaveClass('disabled:opacity-50')
    const group = page.getByRole('radiogroup', { name: 'Chat permissions' })
    await expect.element(group.getByRole('radio', { name: /Read only/ })).toBeDisabled()
    await expect.element(group.getByRole('radio', { name: /Read & write/ })).toBeDisabled()
  })
})
