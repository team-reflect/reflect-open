import { page, type Locator } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { createTestCoreServices, type TestAiKeyValidationService } from '@reflect/core/testing'
import { fireEvent } from '@/test-utils/fire-event.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'

/**
 * The mobile add-provider sheet over the shared submit flow: a verified key
 * hands the draft to `onAdd` and closes, a rejected key shows inline and
 * stores nothing, an unreachable provider downgrades to save-anyway — the
 * same contract the desktop dialog proves through the settings-section tests.
 */

// Keep the sheet content inline so this suite exercises its state flow
// without depending on the drawer's drag and animation behavior.
vi.mock('@/components/ui/drawer.tsx', () => ({
  Drawer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

const { AddAiProviderDrawer } = await import('./add-ai-provider-drawer.tsx')

const onAdd = vi.fn<(draft: unknown) => Promise<void>>()
const onOpenChange = vi.fn<(open: boolean) => void>()

let keyValidation: TestAiKeyValidationService

beforeEach(() => {
  onAdd.mockReset().mockResolvedValue(undefined)
  onOpenChange.mockReset()
})

async function renderSheet(): Promise<void> {
  const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  keyValidation = core.aiKeyValidation
  await renderInApp(<AddAiProviderDrawer open onOpenChange={onOpenChange} onAdd={onAdd} />, {
    core,
    servicesOnly: true,
  })
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
    await renderSheet()
    keyValidation.setResult('valid')

    // Options render in a portal, so query them from the page.
    await selectAnthropic()
    await typeKeyAndSubmit('sk-ant-key')

    await vi.waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic', apiKey: 'sk-ant-key' }),
      )
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows a rejected key inline and stores nothing', async () => {
    await renderSheet()
    keyValidation.setResult('invalid')

    await typeKeyAndSubmit('sk-bad')

    await expect.element(page.getByText(/rejected this API key/)).toBeVisible()
    expect(onAdd).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('downgrades to save-anyway when the provider is unreachable', async () => {
    await renderSheet()
    keyValidation.setResult('unreachable')

    await typeKeyAndSubmit('sk-offline')
    await expect.element(page.getByText(/Couldn’t reach/)).toBeVisible()
    expect(onAdd).not.toHaveBeenCalled()

    await page.getByRole('button', { name: 'Save anyway' }).click()
    await vi.waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-offline' }))
    })
    // The unverified key was saved once, without a second validation probe.
    expect(keyValidation.calls()).toHaveLength(1)
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

    await expect.element(page.getByText(/audio memos send the recording/)).not.toBeInTheDocument()
  })

  it('submits an OpenAI-compatible endpoint without requiring an API key', async () => {
    await renderSheet()
    keyValidation.setResult('valid')

    await page.getByRole('combobox', { name: 'Provider' }).click()
    await page.getByRole('option', { name: 'OpenAI-compatible' }).click()
    fireEvent.change(page.getByLabelText('Endpoint base URL'), {
      target: { value: 'http://localhost:1234/v1' },
    })
    fireEvent.change(page.getByLabelText('Default model'), { target: { value: 'llama-local' } })
    await consentCheckbox().click()
    await page.getByRole('button', { name: 'Add provider' }).click()

    await vi.waitFor(() => {
      expect(keyValidation.calls()).toEqual([
        { provider: 'openai-compatible', apiKey: '', baseUrl: 'http://localhost:1234/v1' },
      ])
    })
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai-compatible',
        apiKey: '',
        baseUrl: 'http://localhost:1234/v1',
        model: 'llama-local',
      }),
    )
  })
})
