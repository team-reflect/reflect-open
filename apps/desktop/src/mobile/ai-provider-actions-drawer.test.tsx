import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AiProviderConfig } from '@reflect/core'

/** The per-provider management sheet: make-default and remove wiring. */

vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

const { AiProviderActionsDrawer } = await import('./ai-provider-actions-drawer')

afterEach(cleanup)

const PROVIDER: AiProviderConfig = {
  id: 'p1',
  provider: 'openai',
  model: 'gpt-5.1',
  keyHint: '12345',
}

const onMakeDefault = vi.fn<(id: string) => void>()
const onRemove = vi.fn<(id: string) => Promise<void>>()
const onOpenChange = vi.fn<(open: boolean) => void>()

beforeEach(() => {
  onMakeDefault.mockReset()
  onRemove.mockReset().mockResolvedValue(undefined)
  onOpenChange.mockReset()
})

function renderSheet(isDefault = false) {
  render(
    <AiProviderActionsDrawer
      provider={PROVIDER}
      isDefault={isDefault}
      open
      onOpenChange={onOpenChange}
      onMakeDefault={onMakeDefault}
      onRemove={onRemove}
    />,
  )
}

describe('AiProviderActionsDrawer', () => {
  it('makes the provider the default and closes', () => {
    renderSheet()

    fireEvent.click(screen.getByRole('button', { name: 'Use as default' }))

    expect(onMakeDefault).toHaveBeenCalledWith('p1')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('the default provider cannot be re-defaulted', () => {
    renderSheet(true)

    expect(
      (screen.getByRole('button', { name: 'Default provider' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('removes the provider and closes once the removal lands', async () => {
    renderSheet()

    fireEvent.click(screen.getByRole('button', { name: 'Remove provider' }))

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith('p1'))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('a failed removal keeps the sheet open for a retry', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    onRemove.mockRejectedValue(new Error('keychain unavailable'))
    renderSheet()

    fireEvent.click(screen.getByRole('button', { name: 'Remove provider' }))

    await waitFor(() => expect(consoleError).toHaveBeenCalled())
    expect(onOpenChange).not.toHaveBeenCalled()
    // The pending spinner cleared — the row is pressable again.
    expect(
      (screen.getByRole('button', { name: 'Remove provider' }) as HTMLButtonElement).disabled,
    ).toBe(false)
    consoleError.mockRestore()
  })
})
