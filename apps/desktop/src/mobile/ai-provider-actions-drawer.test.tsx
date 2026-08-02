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

const COMPATIBLE_P1: AiProviderConfig = {
  id: 'p1',
  provider: 'openai-compatible',
  model: 'local-model',
  baseUrl: 'http://localhost:1234/v1',
  transcriptionModel: 'whisper-1',
  keyHint: '',
}

const COMPATIBLE_P2: AiProviderConfig = {
  id: 'p2',
  provider: 'openai-compatible',
  model: 'local-model',
  baseUrl: 'http://localhost:5678/v1',
  transcriptionModel: 'whisper-large-v3',
  keyHint: '',
}

const onMakeDefault = vi.fn<(id: string) => void>()
const onSetDefaultModel = vi.fn<(id: string, model: string) => void>()
const onSetTranscriptionModel = vi.fn<(id: string, model: string) => void>()
const onMakeTranscriptionDefault = vi.fn<(id: string) => void>()
const onRemove = vi.fn<(id: string) => Promise<void>>()
const onOpenChange = vi.fn<(open: boolean) => void>()

beforeEach(() => {
  onMakeDefault.mockReset()
  onSetDefaultModel.mockReset()
  onSetTranscriptionModel.mockReset()
  onMakeTranscriptionDefault.mockReset()
  onRemove.mockReset().mockResolvedValue(undefined)
  onOpenChange.mockReset()
})

async function renderSheet(isDefault = false, provider: AiProviderConfig = PROVIDER) {
  return render(
    <AiProviderActionsDrawer
      provider={provider}
      isDefault={isDefault}
      isTranscriptionDefault={false}
      open
      onOpenChange={onOpenChange}
      onMakeDefault={onMakeDefault}
      onSetDefaultModel={onSetDefaultModel}
      onSetTranscriptionModel={onSetTranscriptionModel}
      onMakeTranscriptionDefault={onMakeTranscriptionDefault}
      onRemove={onRemove}
    />,
  )
}

describe('AiProviderActionsDrawer', () => {
  it('makes the provider the default and closes', async () => {
    await renderSheet()

    await page.getByRole('button', { name: 'Use as default for chat' }).click()

    expect(onMakeDefault).toHaveBeenCalledWith('p1')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('the default provider cannot be re-defaulted', async () => {
    await renderSheet(true)

    await expect.element(page.getByRole('button', { name: 'Default for chat' })).toBeDisabled()
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
    // The pending spinner cleared - the row is pressable again.
    await expect.element(page.getByRole('button', { name: 'Remove provider' })).toBeEnabled()
    consoleError.mockRestore()
  })

  it('resets the transcription model input draft when the provider changes', async () => {
    // TranscriptionModelInput holds a useState draft seeded from the provider.
    // Without a key, opening a second OpenAI-compatible provider in the same
    // mounted sheet would show the previous provider's model and blur would
    // save it under the new provider id. The key remounts the input on
    // provider change, resetting the draft to the new provider's value.
    const view = await renderSheet(false, COMPATIBLE_P1)
    await expect.element(page.getByLabelText('Transcription model')).toHaveValue('whisper-1')

    await view.rerender(
      <AiProviderActionsDrawer
        provider={COMPATIBLE_P2}
        isDefault={false}
        isTranscriptionDefault={false}
        open
        onOpenChange={onOpenChange}
        onMakeDefault={onMakeDefault}
        onSetDefaultModel={onSetDefaultModel}
        onSetTranscriptionModel={onSetTranscriptionModel}
        onMakeTranscriptionDefault={onMakeTranscriptionDefault}
        onRemove={onRemove}
      />,
    )

    await expect.element(page.getByLabelText('Transcription model')).toHaveValue('whisper-large-v3')
    expect(onSetTranscriptionModel).not.toHaveBeenCalled()
  })
})
