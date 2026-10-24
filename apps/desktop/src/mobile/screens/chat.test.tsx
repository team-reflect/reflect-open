import { page } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRef,
  useLayoutEffect,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import { aiKeySecretName, type AiProviderConfig, type ChatStreamEvent } from '@reflect/core'
import {
  createTestCoreServices,
  createTestChatEngineService,
  createTestSecretStoreService,
  type TestChatEngineService,
} from '@reflect/core/testing'
import type { Route } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'
import { fireEvent } from '@/test-utils/fire-event.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { MobileChat } from './chat.tsx'

/**
 * The Chat tab over a faked engine (the desktop chat-screen harness, mobile
 * shell): the no-provider call-to-action into Settings, a full send through
 * the mobile composer, and the Plan 23 contract that the draft and turns
 * survive the screen unmounting — the session holds them, tab switches only
 * unmount the screen.
 */

// The settings document each test starts from.
const settingsState = {
  models: [] as AiProviderConfig[],
  defaultId: null as string | null,
}

// Keep sheet content inline so this suite isolates the chat flow.
vi.mock('@/components/ui/drawer.tsx', () => ({
  Drawer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

const GRAPH = { root: '/graphs/test', name: 'test-graph', generation: 1 }

const MODEL: AiProviderConfig = { id: 'm1', provider: 'openai', model: 'gpt-5.1', keyHint: '12345' }

let chatEngine: TestChatEngineService

beforeEach(() => {
  settingsState.models = []
  settingsState.defaultId = null
  chatEngine = createTestChatEngineService()
})

function configureModel() {
  settingsState.models = [MODEL]
  settingsState.defaultId = 'm1'
}

function scriptTurn(events: ChatStreamEvent[]) {
  chatEngine.setScript(events)
}

const probedRouteRef: RefObject<Route | null> = createRef()

function RouteProbe(): null {
  const { route } = useRouter()

  useLayoutEffect(() => {
    probedRouteRef.current = route
    return () => {
      probedRouteRef.current = null
    }
  }, [route])

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

/**
 * The screen over the graph's chat session, unmountable like a tab switch.
 */
function Harness(): ReactElement {
  const [showScreen, setShowScreen] = useState(true)
  return (
    <>
      <RouteProbe />
      <FocusChatProbe />
      <button type="button" onClick={() => setShowScreen((shown) => !shown)}>
        switch tab
      </button>
      {showScreen ? <MobileChat /> : null}
    </>
  )
}

async function renderHarness() {
  const core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    secretStore: createTestSecretStoreService({ [aiKeySecretName(MODEL.id)]: 'sk-test' }),
    chatEngine,
  })
  // The index is not open, so the history drawer reads nothing.
  return await renderInApp(<Harness />, {
    core,
    graph: { ...GRAPH, indexGeneration: null },
    settings: { aiProviders: settingsState.models, defaultAiProviderId: settingsState.defaultId },
  })
}

describe('MobileChat', () => {
  it('with no provider, the call-to-action navigates to Settings', async () => {
    await renderHarness()

    await page.getByRole('button', { name: 'Add an AI provider' }).click()

    expect(probedRouteRef.current).toEqual({ kind: 'settings' })
  })

  it('sends the draft from the composer and renders the streamed turn', async () => {
    configureModel()
    scriptTurn([
      { type: 'text-delta', text: 'Grounded answer.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Grounded answer.' }] },
    ])
    await renderHarness()

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
    await renderHarness()

    fireEvent.change(page.getByLabelText('Chat message'), {
      target: { value: 'sent question' },
    })
    await page.getByRole('button', { name: 'Send' }).click()
    await expect.element(page.getByText('Kept.')).toBeVisible()

    fireEvent.change(page.getByLabelText('Chat message'), {
      target: { value: 'half-typed follow-up' },
    })

    await page.getByRole('button', { name: 'switch tab' }).click()
    await expect.element(page.getByLabelText('Chat message')).not.toBeInTheDocument()
    await page.getByRole('button', { name: 'switch tab' }).click()

    await expect.element(page.getByLabelText('Chat message')).toHaveValue('half-typed follow-up')
    await expect.element(page.getByText('sent question')).toBeVisible()
  })

  it('focuses the composer when a chat tab capture arrival requests it', async () => {
    configureModel()
    await renderHarness()

    const composer = page.getByLabelText('Chat message')
    await page.getByRole('button', { name: 'focus chat input' }).click()

    await vi.waitFor(() => expect(document.activeElement).toBe(composer.element()))
  })
})
