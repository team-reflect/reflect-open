import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AiProviderConfig } from '@reflect/core'

/** The per-provider management sheet: make-default and remove wiring. */

vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

const { AiProviderActionsDrawer } = await import('./ai-provider-actions-drawer')

const PROVIDER: AiProviderConfig = {
  id: 'p1',
  provider: 'openai',
  model: 'gpt-5.1',
  keyHint: '12345',
}

const onMakeDefault = vi.fn<(id: string) => void>()
const onSetDefaultModel = vi.fn<(id: string, model: string) => void>()
const onRemove = vi.fn<(id: string) => Promise<void>>()
const onOpenChange = vi.fn<(open: boolean) => void>()

beforeEach(() => {
  onMakeDefault.mockReset()
  onSetDefaultModel.mockReset()
  onRemove.mockReset().mockResolvedValue(undefined)
  onOpenChange.mockReset()
})

async function renderSheet(isDefault = false) {
  await render(
    <AiProviderActionsDrawer
      provider={PROVIDER}
      isDefault={isDefault}
      open
      onOpenChange={onOpenChange}
      onMakeDefault={onMakeDefault}
      onSetDefaultModel={onSetDefaultModel}
      onRemove={onRemove}
    />,
  )
}

describe('AiProviderActionsDrawer', () => {
  it('makes the provider the default and closes', async () => {
    await renderSheet()

    await page.getByRole('button', { name: 'Use as default' }).click()

    expect(onMakeDefault).toHaveBeenCalledWith('p1')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('the default provider cannot be re-defaulted', async () => {
    await renderSheet(true)

    await expect.element(page.getByRole('button', { name: 'Default provider' })).toBeDisabled()
  })

  it('changes the provider default model and closes', async () => {
    await renderSheet()

    await page.getByRole('button', { name: 'GPT-5.4 mini' }).click()

    expect(onSetDefaultModel).toHaveBeenCalledWith('p1', 'gpt-5.4-mini')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('removes the provider and closes once the removal lands', async () => {
    await renderSheet()

    await page.getByRole('button', { name: 'Remove provider' }).click()

    await vi.waitFor(() => expect(onRemove).toHaveBeenCalledWith('p1'))
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('a failed removal keeps the sheet open for a retry', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    onRemove.mockRejectedValue(new Error('keychain unavailable'))
    await renderSheet()

    await page.getByRole('button', { name: 'Remove provider' }).click()

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled())
    expect(onOpenChange).not.toHaveBeenCalled()
    // The pending spinner cleared — the row is pressable again.
    await expect.element(page.getByRole('button', { name: 'Remove provider' })).toBeEnabled()
    consoleError.mockRestore()
  })
})
