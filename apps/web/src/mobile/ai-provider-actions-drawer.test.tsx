import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderConfig } from '@reflect/core'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { AiProviderActionsDrawer } from './ai-provider-actions-drawer.tsx'

/** The per-provider management sheet: make-default and remove wiring. */

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

// The sheet has no scrolling body, so it needs a phone-tall window to show every row.
beforeEach(async () => {
  await page.viewport(390, 844)
  onMakeDefault.mockReset()
  onSetDefaultModel.mockReset()
  onRemove.mockReset().mockResolvedValue(undefined)
  onOpenChange.mockReset()
})

afterEach(async () => {
  await page.viewport(900, 600)
})

async function renderSheet(isDefault = false) {
  return await renderInApp(
    <AiProviderActionsDrawer
      provider={PROVIDER}
      isDefault={isDefault}
      open
      onOpenChange={onOpenChange}
      onMakeDefault={onMakeDefault}
      onSetDefaultModel={onSetDefaultModel}
      onRemove={onRemove}
    />,
    { servicesOnly: true },
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
    onRemove.mockRejectedValue(new Error('keychain unavailable'))
    const { core } = await renderSheet()

    await page.getByRole('button', { name: 'Remove provider' }).click()

    await vi.waitFor(() => {
      expect(core.logger.getErrors()).toEqual([
        { message: 'AI provider removal failed:', cause: 'keychain unavailable' },
      ])
    })
    expect(onOpenChange).not.toHaveBeenCalled()
    // The pending spinner cleared — the row is pressable again.
    await expect.element(page.getByRole('button', { name: 'Remove provider' })).toBeEnabled()
  })
})
