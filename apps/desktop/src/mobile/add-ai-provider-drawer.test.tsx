import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiKeyValidation } from '@reflect/core'

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

// vaul needs browser APIs jsdom doesn't provide; passthrough so the sheet
// content renders inline.
vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

// jsdom doesn't implement this; Radix Select scrolls the selected option into
// view when the listbox opens.
Element.prototype.scrollIntoView ??= () => {}

const { AddAiProviderDrawer } = await import('./add-ai-provider-drawer')

afterEach(cleanup)

const onAdd = vi.fn<(draft: unknown) => Promise<void>>()
const onOpenChange = vi.fn<(open: boolean) => void>()

beforeEach(() => {
  validateApiKey.mockReset()
  onAdd.mockReset().mockResolvedValue(undefined)
  onOpenChange.mockReset()
})

function renderSheet() {
  render(<AddAiProviderDrawer open onOpenChange={onOpenChange} onAdd={onAdd} />)
}

async function typeKeyAndSubmit(key: string, submitLabel = 'Add provider') {
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: key } })
  fireEvent.click(screen.getByRole('button', { name: submitLabel }))
}

describe('AddAiProviderDrawer', () => {
  it('verifies the key, hands the draft to onAdd, and closes', async () => {
    validateApiKey.mockResolvedValue('valid')
    renderSheet()

    // Keyboard-driven (the pointer path needs capture APIs jsdom lacks);
    // options render in a portal, so they're queried from screen.
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Provider' }), { key: 'ArrowDown' })
    fireEvent.keyDown(await screen.findByRole('option', { name: 'Anthropic' }), { key: 'Enter' })
    await typeKeyAndSubmit('sk-ant-key')

    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic', apiKey: 'sk-ant-key' }),
      ),
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows a rejected key inline and stores nothing', async () => {
    validateApiKey.mockResolvedValue('invalid')
    renderSheet()

    await typeKeyAndSubmit('sk-bad')

    await waitFor(() => expect(screen.getByText(/rejected this API key/)).toBeDefined())
    expect(onAdd).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('downgrades to save-anyway when the provider is unreachable', async () => {
    validateApiKey.mockResolvedValue('unreachable')
    renderSheet()

    await typeKeyAndSubmit('sk-offline')
    await waitFor(() => expect(screen.getByText(/Couldn’t reach/)).toBeDefined())
    expect(onAdd).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }))
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-offline' })),
    )
    // The unverified key was saved once, without a second validation probe.
    expect(validateApiKey).toHaveBeenCalledTimes(1)
  })
})
