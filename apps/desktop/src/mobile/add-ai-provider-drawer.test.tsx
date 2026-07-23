import { cleanup, render } from 'vitest-browser-react'
import { page, type Locator } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiKeyValidation } from '@reflect/core'
import { fireEvent } from '@/test-utils/fire-event'

/**
 * The mobile add-provider sheet over the shared submit flow: a verified key
 * hands the draft to `onAdd` and closes, a rejected key shows inline and
 * stores nothing, an unreachable provider downgrades to save-anyway — the
 * same contract the desktop dialog proves through the settings-section tests.
 */

const validateApiKey = vi.hoisted(() =>
  vi.fn<(provider: string, key: string, fetchFn?: typeof fetch) => Promise<ApiKeyValidation>>(),
)
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  validateApiKey,
}))
vi.mock('@/lib/provider-fetch', () => ({ providerFetch: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }))

// Keep the sheet content inline so this suite exercises its state flow
// without depending on vaul's drag and animation behavior.
vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

const { AddAiProviderDrawer } = await import('./add-ai-provider-drawer')

afterEach(async () => {
  await cleanup()
})

const onAdd = vi.fn<(draft: unknown) => Promise<void>>()
const onOpenChange = vi.fn<(open: boolean) => void>()

beforeEach(() => {
  validateApiKey.mockReset()
  onAdd.mockReset().mockResolvedValue(undefined)
  onOpenChange.mockReset()
})

async function renderSheet(): Promise<void> {
  await render(<AddAiProviderDrawer open onOpenChange={onOpenChange} onAdd={onAdd} />)
}

function consentCheckbox(): Locator {
  return page.getByRole('checkbox', { name: /I understand this data will be sent/ })
}

async function typeKeyAndSubmit(key: string, submitLabel = 'Add provider') {
  fireEvent.change(page.getByLabelText('API key'), { target: { value: key } })
  await consentCheckbox().click()
  await page.getByRole('button', { name: submitLabel }).click()
}

async function selectAnthropic(): Promise<void> {
  await page.getByRole('combobox', { name: 'Provider' }).click()
  await page.getByRole('option', { name: 'Anthropic' }).click()
}

describe('AddAiProviderDrawer', () => {
  it('verifies the key, hands the draft to onAdd, and closes', async () => {
    validateApiKey.mockResolvedValue('valid')
    await renderSheet()

    // Options render in a portal, so query them from the page.
    await selectAnthropic()
    await typeKeyAndSubmit('sk-ant-key')

    await vi.waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic', apiKey: 'sk-ant-key' }),
      ),
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows a rejected key inline and stores nothing', async () => {
    validateApiKey.mockResolvedValue('invalid')
    await renderSheet()

    await typeKeyAndSubmit('sk-bad')

    await expect.element(page.getByText(/rejected this API key/)).toBeVisible()
    expect(onAdd).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('downgrades to save-anyway when the provider is unreachable', async () => {
    validateApiKey.mockResolvedValue('unreachable')
    await renderSheet()

    await typeKeyAndSubmit('sk-offline')
    await expect.element(page.getByText(/Couldn’t reach/)).toBeVisible()
    expect(onAdd).not.toHaveBeenCalled()

    await page.getByRole('button', { name: 'Save anyway' }).click()
    await vi.waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-offline' })),
    )
    // The unverified key was saved once, without a second validation probe.
    expect(validateApiKey).toHaveBeenCalledTimes(1)
  })

  it('keeps the submit disabled until the data-sharing consent is checked', async () => {
    await renderSheet()

    fireEvent.change(page.getByLabelText('API key'), { target: { value: 'sk-key' } })
    await expect.element(page.getByRole('button', { name: 'Add provider' })).toBeDisabled()

    await consentCheckbox().click()
    await expect.element(page.getByRole('button', { name: 'Add provider' })).toBeEnabled()
  })

  it('resets consent when the provider changes', async () => {
    await renderSheet()

    await consentCheckbox().click()
    await expect.element(consentCheckbox()).toBeChecked()

    await selectAnthropic()

    await expect.element(consentCheckbox()).not.toBeChecked()
  })

  it('mentions audio only for transcription-capable providers', async () => {
    await renderSheet()

    await expect.element(page.getByText(/audio memos send the recording/)).toBeVisible()

    await selectAnthropic()

    await expect
      .element(page.getByText(/audio memos send the recording/))
      .not.toBeInTheDocument()
  })
})
