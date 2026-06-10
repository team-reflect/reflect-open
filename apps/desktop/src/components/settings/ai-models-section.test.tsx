import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge, settingsSchema, type AiModelConfig, type Settings } from '@reflect/core'
import { SettingsProvider } from '@/providers/settings-provider'
import { resetOperations } from '@/lib/operations'
import { AiModelsSection } from './ai-models-section'

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
          saved.push(args.settings)
          return null
        case 'secret_set':
          if (failSecretSet) {
            throw { kind: 'io', message: 'keychain locked' }
          }
          secrets.set(args.name as string, args.value as string)
          return null
        case 'secret_delete':
          secrets.delete(args.name as string)
          return null
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
}

let queryClient: QueryClient

function renderSection(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <AiModelsSection />
      </SettingsProvider>
    </QueryClientProvider>,
  )
}

/** The most recently persisted document, parsed. */
function lastSavedDoc(): Settings {
  return settingsSchema.parse(saved.at(-1))
}

function entry(overrides: Partial<AiModelConfig>): AiModelConfig {
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
    aiModels: [
      entry({ id: 'a' }),
      entry({ id: 'b', provider: 'openai', model: 'gpt-5.1', keyHint: 'abcd2' }),
    ],
    defaultAiModelId: 'a',
  }
}

function openDialog(): ReturnType<typeof within> {
  fireEvent.click(screen.getByRole('button', { name: /add model/i }))
  return within(screen.getByRole('dialog', { name: 'Add AI model' }))
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
  cleanup()
  setBridge(null)
  queryClient.clear()
  resetOperations()
})

describe('AiModelsSection', () => {
  it('lists configured models with their key hint and default badge', async () => {
    stored = twoStoredModels()
    renderSection()

    await waitFor(() =>
      expect(screen.getByText('Anthropic — Claude Opus 4.8')).toBeTruthy(),
    )
    expect(screen.getByText('OpenAI — GPT-5.1')).toBeTruthy()
    expect(screen.getByText(/wxyz1/)).toBeTruthy()
    expect(screen.getByText(/abcd2/)).toBeTruthy()
    expect(screen.getByText('Default')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Make default' })).toBeTruthy()
  })

  it('adds a model: key verified, then keychain + settings entry', async () => {
    renderSection()
    await waitFor(() => expect(screen.getByText(/No AI models configured/)).toBeTruthy())

    const dialog = openDialog()
    fireEvent.change(dialog.getByLabelText('Provider'), { target: { value: 'anthropic' } })
    fireEvent.change(dialog.getByLabelText('Model'), {
      target: { value: 'claude-sonnet-4-6' },
    })
    fireEvent.change(dialog.getByLabelText('API key'), {
      target: { value: 'sk-ant-test-wxyz1' },
    })
    fireEvent.click(dialog.getByRole('button', { name: 'Add model' }))

    await waitFor(() => expect(saved).toHaveLength(1))
    const doc = lastSavedDoc()
    const [added] = doc.aiModels
    expect(added).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      keyHint: 'wxyz1',
    })
    // The first entry becomes the default automatically.
    expect(doc.defaultAiModelId).toBe(added.id)
    // The key was verified against the provider before being stored.
    expect(providerFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({ method: 'GET' }),
    )
    // The full key reached the keychain (and only the keychain).
    expect(secrets.get(`ai-api-key:${added.id}`)).toBe('sk-ant-test-wxyz1')
    expect(JSON.stringify(saved)).not.toContain('sk-ant-test-wxyz1')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('rejects a key the provider turns down, storing nothing', async () => {
    providerFetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    renderSection()
    await waitFor(() => expect(screen.getByText(/No AI models configured/)).toBeTruthy())

    const dialog = openDialog()
    fireEvent.change(dialog.getByLabelText('API key'), { target: { value: 'sk-typo' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add model' }))

    await waitFor(() =>
      expect(dialog.getByRole('alert').textContent).toMatch(/rejected this API key/i),
    )
    expect(secrets.size).toBe(0)
    expect(saved).toEqual([])
  })

  it('offers save-anyway when the provider cannot be reached', async () => {
    providerFetchMock.mockRejectedValue(new TypeError('offline'))
    renderSection()
    await waitFor(() => expect(screen.getByText(/No AI models configured/)).toBeTruthy())

    const dialog = openDialog()
    fireEvent.change(dialog.getByLabelText('API key'), { target: { value: 'sk-offline-key' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add model' }))

    // First submit downgrades to an explicit unverified save, not a block.
    await waitFor(() => expect(dialog.getByRole('alert').textContent).toMatch(/reach OpenAI/))
    expect(saved).toEqual([])

    fireEvent.click(dialog.getByRole('button', { name: 'Save anyway' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(secrets.size).toBe(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a failed keychain write keeps the dialog open and persists nothing', async () => {
    renderSection()
    await waitFor(() => expect(screen.getByText(/No AI models configured/)).toBeTruthy())
    failSecretSet = true

    const dialog = openDialog()
    fireEvent.change(dialog.getByLabelText('API key'), { target: { value: 'sk-test' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add model' }))

    await waitFor(() => expect(dialog.getByRole('alert').textContent).toBe('keychain locked'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(saved).toEqual([])
    expect(secrets.size).toBe(0)
  })

  it('refuses to add when the settings store failed to load (no orphaned key)', async () => {
    failLoad = true
    renderSection()
    await waitFor(() => expect(screen.getByText(/No AI models configured/)).toBeTruthy())

    const dialog = openDialog()
    fireEvent.change(dialog.getByLabelText('API key'), { target: { value: 'sk-test' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add model' }))

    // A session-only entry would vanish on restart, stranding the key in the
    // keychain with no UI to delete it — so the key must never be stored.
    await waitFor(() =>
      expect(dialog.getByRole('alert').textContent).toMatch(/could not be loaded/i),
    )
    expect(secrets.size).toBe(0)
    expect(saved).toEqual([])
  })

  it('removes a model, deletes its secret, and promotes the next default', async () => {
    stored = twoStoredModels()
    secrets.set('ai-api-key:a', 'sk-a')
    renderSection()
    await waitFor(() =>
      expect(screen.getByText('Anthropic — Claude Opus 4.8')).toBeTruthy(),
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Anthropic — Claude Opus 4.8' }),
    )

    await waitFor(() =>
      expect(lastSavedDoc()).toMatchObject({
        aiModels: [entry({ id: 'b', provider: 'openai', model: 'gpt-5.1', keyHint: 'abcd2' })],
        defaultAiModelId: 'b',
      }),
    )
    expect(secrets.has('ai-api-key:a')).toBe(false)
  })

  it('overlapping removes both land instead of clobbering each other', async () => {
    stored = twoStoredModels()
    secrets.set('ai-api-key:a', 'sk-a')
    secrets.set('ai-api-key:b', 'sk-b')
    renderSection()
    await waitFor(() =>
      expect(screen.getByText('Anthropic — Claude Opus 4.8')).toBeTruthy(),
    )

    // Both removes fire in the same tick; each suspends on its keychain
    // delete, so each settings update applies after the other's snapshot
    // went stale. A snapshot-based write would leave one row behind with
    // its key already gone from the keychain.
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Anthropic — Claude Opus 4.8' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove OpenAI — GPT-5.1' }))

    await waitFor(() =>
      expect(lastSavedDoc()).toMatchObject({ aiModels: [], defaultAiModelId: null }),
    )
    expect(secrets.size).toBe(0)
  })

  it('make default moves the id', async () => {
    stored = twoStoredModels()
    renderSection()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Make default' })).toBeTruthy(),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Make default' }))

    await waitFor(() => expect(lastSavedDoc().defaultAiModelId).toBe('b'))
    expect(lastSavedDoc().aiModels).toHaveLength(2)
  })

  it('traps Tab inside the dialog', async () => {
    renderSection()
    await waitFor(() => expect(screen.getByText(/No AI models configured/)).toBeTruthy())

    const dialog = openDialog()
    const submitButton = dialog.getByRole('button', { name: 'Add model' })
    submitButton.focus()
    fireEvent.keyDown(submitButton, { key: 'Tab' })

    // From the last control, Tab wraps to the first instead of escaping
    // into the settings page behind the modal.
    expect(document.activeElement).toBe(dialog.getByLabelText('Provider'))
  })

  it('falls back to the first entry when the default id dangles', async () => {
    stored = { ...twoStoredModels(), defaultAiModelId: 'gone' }
    renderSection()

    await waitFor(() => expect(screen.getByText('Default')).toBeTruthy())
    // The badge lands on the first row; the second still offers "Make default".
    expect(screen.getByRole('button', { name: 'Make default' })).toBeTruthy()
  })
})
