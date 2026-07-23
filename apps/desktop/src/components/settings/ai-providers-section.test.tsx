import { render } from 'vitest-browser-react'
import { page, userEvent, type Locator } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge, settingsSchema, type AiProviderConfig, type Settings } from '@reflect/core'
import { SettingsProvider } from '@/providers/settings-provider'
import { resetOperations } from '@/lib/operations'
import { expectLocatorToHaveCount } from '@/test-utils/expect'
import { AiProvidersSection } from './ai-providers-section'

// The dialog verifies keys against the provider through this transport; the
// default per-test behavior is "key accepted".
const { providerFetchMock } = vi.hoisted(() => ({ providerFetchMock: vi.fn() }))
vi.mock('@/lib/provider-fetch', () => ({ providerFetch: providerFetchMock }))

let stored: Record<string, unknown>
let saved: unknown[]
let secrets: Map<string, string>
let failSecretSet: boolean
let failLoad: boolean

function installFakeBridge(): void {
  saved = []
  secrets = new Map()
  failSecretSet = false
  failLoad = false
  setBridge({
    invoke: async (command, args) => {
      switch (command) {
        case 'settings_load':
          if (failLoad) {
            throw { kind: 'io', message: 'corrupt store' }
          }
          return stored
        case 'settings_save':
          saved.push(args['settings'])
          return null
        case 'secret_set':
          if (failSecretSet) {
            throw { kind: 'io', message: 'keychain locked' }
          }
          secrets.set(args['name'] as string, args['value'] as string)
          return null
        case 'secret_delete':
          secrets.delete(args['name'] as string)
          return null
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
}

let queryClient: QueryClient

async function renderSection(): Promise<void> {
  await render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <AiProvidersSection />
      </SettingsProvider>
    </QueryClientProvider>,
  )
}

/** The most recently persisted document, parsed. */
function lastSavedDoc(): Settings {
  return settingsSchema.parse(saved.at(-1))
}

function entry(overrides: Partial<AiProviderConfig>): AiProviderConfig {
  return {
    id: 'id',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    keyHint: 'wxyz1',
    ...overrides,
  }
}

/** Two configured entries with 'a' as the default. */
function twoStoredModels(): Record<string, unknown> {
  return {
    aiProviders: [
      entry({ id: 'a' }),
      entry({ id: 'b', provider: 'openai', model: 'gpt-5.5', keyHint: 'abcd2' }),
    ],
    defaultAiProviderId: 'a',
  }
}

async function openDialog(): Promise<Locator> {
  await page.getByRole('button', { name: /add provider/i }).click()
  return page.getByRole('dialog', { name: 'Add AI provider' })
}

beforeEach(() => {
  stored = {}
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  installFakeBridge()
  providerFetchMock.mockReset()
  providerFetchMock.mockResolvedValue(new Response(null, { status: 200 }))
})

afterEach(() => {
  setBridge(null)
  queryClient.clear()
  resetOperations()
})

describe('AiProvidersSection', () => {
  it('lists configured providers with their key hint and default badge', async () => {
    stored = twoStoredModels()
    await renderSection()

    await expect.element(page.getByText('Anthropic')).toBeInTheDocument()
    await expect.element(page.getByText('OpenAI')).toBeInTheDocument()
    await expect
      .element(page.getByRole('combobox', { name: 'Default model for Anthropic' }))
      .toHaveTextContent(/Claude Opus 4\.8/)
    await expect
      .element(page.getByRole('combobox', { name: 'Default model for OpenAI' }))
      .toHaveTextContent(/GPT-5\.5/)
    await expect.element(page.getByText(/wxyz1/)).toBeInTheDocument()
    await expect.element(page.getByText(/abcd2/)).toBeInTheDocument()
    await expect.element(page.getByText('Default', { exact: true })).toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Make default' }))
      .toBeInTheDocument()
  })

  it('adds a model: key verified, then keychain + settings entry', async () => {
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    // Options render in a portal, so they're queried from the page.
    await dialog.getByRole('combobox', { name: 'Provider' }).click()
    await page.getByRole('option', { name: 'Anthropic' }).click()
    await dialog.getByRole('combobox', { name: 'Default model' }).click()
    await page.getByRole('option', { name: /Claude Sonnet 5/ }).click()
    await dialog.getByLabelText('API key').fill('sk-ant-test-wxyz1')
    await dialog.getByRole('button', { name: 'Add provider' }).click()

    await vi.waitFor(() => expect(saved).toHaveLength(1))
    const doc = lastSavedDoc()
    const [added] = doc.aiProviders
    expect(added).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      keyHint: 'wxyz1',
    })
    // The first entry becomes the default automatically.
    expect(doc.defaultAiProviderId).toBe(added!.id)
    // The key was verified against the provider before being stored.
    expect(providerFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({ method: 'GET' }),
    )
    // The full key reached the keychain (and only the keychain).
    expect(secrets.get(`ai-api-key:${added!.id}`)).toBe('sk-ant-test-wxyz1')
    expect(JSON.stringify(saved)).not.toContain('sk-ant-test-wxyz1')
    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
  })

  it('offers OpenRouter in the provider picker', async () => {
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    await dialog.getByRole('combobox', { name: 'Provider' }).click()

    await expect.element(page.getByRole('option', { name: 'OpenRouter' })).toBeInTheDocument()
  })

  it('rejects a key the provider turns down, storing nothing', async () => {
    providerFetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    await dialog.getByLabelText('API key').fill('sk-typo')
    await dialog.getByRole('button', { name: 'Add provider' }).click()

    await expect.element(dialog.getByRole('alert')).toHaveTextContent(/rejected this API key/i)
    expect(secrets.size).toBe(0)
    expect(saved).toEqual([])
  })

  it('offers save-anyway when the provider cannot be reached', async () => {
    providerFetchMock.mockRejectedValue(new TypeError('offline'))
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    await dialog.getByLabelText('API key').fill('sk-offline-key')
    await dialog.getByRole('button', { name: 'Add provider' }).click()

    // First submit downgrades to an explicit unverified save, not a block.
    await expect.element(dialog.getByRole('alert')).toHaveTextContent(/reach OpenAI/)
    expect(saved).toEqual([])

    await dialog.getByRole('button', { name: 'Save anyway' }).click()
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    expect(secrets.size).toBe(1)
    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
  })

  it('a failed keychain write keeps the dialog open and persists nothing', async () => {
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()
    failSecretSet = true

    const dialog = await openDialog()
    await dialog.getByLabelText('API key').fill('sk-test')
    await dialog.getByRole('button', { name: 'Add provider' }).click()

    await expect.element(dialog.getByRole('alert')).toHaveTextContent(/^keychain locked$/)
    await expect.element(page.getByRole('dialog')).toBeInTheDocument()
    expect(saved).toEqual([])
    expect(secrets.size).toBe(0)
  })

  it('refuses to add when the settings store failed to load (no orphaned key)', async () => {
    failLoad = true
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    await dialog.getByLabelText('API key').fill('sk-test')
    await dialog.getByRole('button', { name: 'Add provider' }).click()

    // A session-only entry would vanish on restart, stranding the key in the
    // keychain with no UI to delete it — so the key must never be stored.
    await expect.element(dialog.getByRole('alert')).toHaveTextContent(/could not be loaded/i)
    expect(secrets.size).toBe(0)
    expect(saved).toEqual([])
  })

  it('removes a model, deletes its secret, and promotes the next default', async () => {
    stored = twoStoredModels()
    secrets.set('ai-api-key:a', 'sk-a')
    await renderSection()
    await expect.element(page.getByText('Anthropic')).toBeInTheDocument()

    await page.getByRole('button', { name: 'Remove Anthropic — Claude Opus 4.8' }).click()

    await vi.waitFor(() =>
      expect(lastSavedDoc()).toMatchObject({
        aiProviders: [entry({ id: 'b', provider: 'openai', model: 'gpt-5.5', keyHint: 'abcd2' })],
        defaultAiProviderId: 'b',
      }),
    )
    expect(secrets.has('ai-api-key:a')).toBe(false)
  })

  it('overlapping removes both land instead of clobbering each other', async () => {
    stored = twoStoredModels()
    secrets.set('ai-api-key:a', 'sk-a')
    secrets.set('ai-api-key:b', 'sk-b')
    await renderSection()
    await expect.element(page.getByText('Anthropic')).toBeInTheDocument()

    // Both removes fire in the same tick; each suspends on its keychain
    // delete, so each settings update applies after the other's snapshot
    // went stale. A snapshot-based write would leave one row behind with
    // its key already gone from the keychain.
    ;(page.getByRole('button', { name: 'Remove Anthropic — Claude Opus 4.8' }).element() as HTMLElement).click()
    ;(page.getByRole('button', { name: 'Remove OpenAI — GPT-5.5' }).element() as HTMLElement).click()

    await vi.waitFor(() =>
      expect(lastSavedDoc()).toMatchObject({ aiProviders: [], defaultAiProviderId: null }),
    )
    expect(secrets.size).toBe(0)
  })

  it('make default moves the id', async () => {
    stored = twoStoredModels()
    await renderSection()
    await expect
      .element(page.getByRole('button', { name: 'Make default' }))
      .toBeInTheDocument()

    await page.getByRole('button', { name: 'Make default' }).click()

    await vi.waitFor(() => expect(lastSavedDoc().defaultAiProviderId).toBe('b'))
    expect(lastSavedDoc().aiProviders).toHaveLength(2)
  })

  it('changes a configured provider default model without replacing its key', async () => {
    stored = twoStoredModels()
    secrets.set('ai-api-key:b', 'sk-openai-secret')
    await renderSection()

    await page.getByRole('combobox', { name: 'Default model for OpenAI' }).click()
    await page.getByRole('option', { name: /GPT-5\.4 mini/ }).click()

    await vi.waitFor(() => {
      expect(lastSavedDoc().aiProviders).toContainEqual(
        entry({ id: 'b', provider: 'openai', model: 'gpt-5.4-mini', keyHint: 'abcd2' }),
      )
    })
    expect(secrets.get('ai-api-key:b')).toBe('sk-openai-secret')
  })

  it('traps Tab inside the dialog', async () => {
    await renderSection()
    await expect.element(page.getByText(/No AI providers configured/)).toBeInTheDocument()

    const dialog = await openDialog()
    const submitButton = dialog.getByRole('button', { name: 'Add provider' })
    submitButton.element().focus()
    await userEvent.keyboard('{Tab}')

    // From the last control, Tab wraps to the first instead of escaping
    // into the settings page behind the modal.
    expect(document.activeElement).toBe(dialog.getByLabelText('Provider', { exact: true }).element())
  })

  it('falls back to the first entry when the default id dangles', async () => {
    stored = { ...twoStoredModels(), defaultAiProviderId: 'gone' }
    await renderSection()

    await expect.element(page.getByText('Default', { exact: true })).toBeInTheDocument()
    // The badge lands on the first row; the second still offers "Make default".
    await expect
      .element(page.getByRole('button', { name: 'Make default' }))
      .toBeInTheDocument()
  })
})
