import type { RenderResult } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@/test-utils/act.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { WritableStore, type AudioMemoSessionState } from '@reflect/core'
import { AudioMemoContext, type AudioMemoContextValue } from '@/providers/audio-memo-provider.tsx'
import { AudioMemoButton } from './audio-memo-button.tsx'

const IDLE: AudioMemoSessionState = {
  phase: 'idle',
  stream: null,
  available: true,
  unavailableReason: null,
  error: null,
  canRetry: false,
  pendingCount: 0,
  recorderState: 'idle',
}

const state = new WritableStore(IDLE)
const elapsedMs = new WritableStore(0)
const actions = { toggle: vi.fn(), cancel: vi.fn(), retry: vi.fn(), discard: vi.fn() }
const session = { get: state.get, subscribe: state.subscribe, elapsedMs }
let presentation: AudioMemoContextValue['presentation'] = 'popover'

function setMemo(patch: Partial<AudioMemoSessionState>): void {
  state.set({ ...state.get(), ...patch })
}

function renderButton(): Promise<RenderResult> {
  return renderInApp(
    <AudioMemoContext value={{ session, ...actions, presentation }}>
      <AudioMemoButton />
    </AudioMemoContext>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  state.set(IDLE)
  elapsedMs.set(0)
  presentation = 'popover'
})

describe('AudioMemoButton', () => {
  it('unavailable renders aria-disabled — never natively disabled — and ignores clicks', async () => {
    setMemo({
      available: false,
      unavailableReason: 'Add an OpenAI or Gemini model in Settings to record audio memos',
    })
    const view = await renderButton()

    // aria-disabled (not `disabled`) keeps pointer events alive so the
    // explanatory tooltip can fire; the reason copy itself is asserted in the
    // provider test.
    const micButton = view.getByRole('button', { name: 'Record audio memo' })
    await expect.element(micButton).toHaveAttribute('aria-disabled', 'true')
    expect(micButton.element()).toHaveProperty('disabled', false)

    // force: playwright refuses to click aria-disabled controls on its own.
    await userEvent.click(micButton, { force: true })
    expect(actions.toggle).not.toHaveBeenCalled()
  })

  it('recording shows the stop control and the elapsed time', async () => {
    setMemo({ phase: 'recording' })
    elapsedMs.set(83_000)
    const view = await renderButton()

    await expect.element(view.getByText('1:23')).toBeInTheDocument()
    await act(() => {
      elapsedMs.set(84_000)
    })
    await expect.element(view.getByText('1:24')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Stop recording' }))
    expect(actions.toggle).toHaveBeenCalled()
  })

  it('escape cancels a recording without transcribing', async () => {
    setMemo({ phase: 'recording' })
    const view = await renderButton()

    view.getByRole('button', { name: 'Stop recording' }).element().focus()
    await userEvent.keyboard('{Escape}')
    expect(actions.cancel).toHaveBeenCalled()
    expect(actions.toggle).not.toHaveBeenCalled()
  })

  it('escape is inert while transcribing — stopping committed the save', async () => {
    setMemo({ phase: 'transcribing' })
    await renderButton()

    await userEvent.keyboard('{Escape}')
    expect(actions.cancel).not.toHaveBeenCalled()
    expect(actions.discard).not.toHaveBeenCalled()
  })

  it('transcribing shows progress while the mic stays live for the next memo', async () => {
    setMemo({ phase: 'transcribing' })
    const view = await renderButton()

    await expect.element(view.getByText('Transcribing…')).toBeInTheDocument()
    const micButton = view.getByRole('button', { name: 'Record audio memo' })
    expect(micButton.element()).toHaveProperty('disabled', false)
    await userEvent.click(micButton)
    expect(actions.toggle).toHaveBeenCalled()
  })

  it('a resumable failure offers Retry and Discard', async () => {
    setMemo({ phase: 'error', error: 'provider down', canRetry: true })
    const view = await renderButton()

    await expect.element(view.getByText('provider down')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Retry' }))
    expect(actions.retry).toHaveBeenCalled()
    await userEvent.click(view.getByRole('button', { name: 'Discard', exact: true }))
    expect(actions.discard).toHaveBeenCalled()
  })

  describe('with the iOS recording sheet', () => {
    beforeEach(() => {
      presentation = 'sheet'
    })

    it('starts from the mic without a popover of its own', async () => {
      const view = await renderButton()

      await userEvent.click(view.getByRole('button', { name: 'Record audio memo' }))
      expect(actions.toggle).toHaveBeenCalledTimes(1)
      await expect.element(view.getByRole('dialog')).not.toBeInTheDocument()
    })

    it('stops from the mic, leaving the recording UI to the sheet', async () => {
      setMemo({ phase: 'recording' })
      const view = await renderButton()

      await userEvent.click(view.getByRole('button', { name: 'Stop recording' }))
      expect(actions.toggle).toHaveBeenCalledTimes(1)
      await expect.element(view.getByRole('dialog')).not.toBeInTheDocument()
    })

    it('stops a pending permission request from the same control', async () => {
      setMemo({ phase: 'requesting' })
      const view = await renderButton()

      await userEvent.click(view.getByRole('button', { name: 'Stop recording' }))
      expect(actions.toggle).toHaveBeenCalledTimes(1)
      await expect
        .element(view.getByRole('button', { name: 'Record audio memo' }))
        .not.toBeInTheDocument()
    })

    it('keeps the plain mic while transcribing, leaving the progress to the sheet', async () => {
      setMemo({ phase: 'transcribing' })
      const view = await renderButton()

      await userEvent.click(view.getByRole('button', { name: 'Record audio memo' }))
      expect(actions.toggle).toHaveBeenCalledTimes(1)
      await expect.element(view.getByRole('dialog')).not.toBeInTheDocument()
    })

    it('offers to show a parked error, which the sheet presents', async () => {
      setMemo({ phase: 'error', error: 'provider down' })
      const view = await renderButton()

      await userEvent.click(view.getByRole('button', { name: 'Show audio memo error' }))
      expect(actions.toggle).toHaveBeenCalledTimes(1)
      await expect.element(view.getByRole('dialog')).not.toBeInTheDocument()
      await expect.element(view.getByText('provider down')).not.toBeInTheDocument()
    })
  })

  it('a non-resumable failure hides Retry', async () => {
    setMemo({ phase: 'error', error: 'came back empty', canRetry: false })
    const view = await renderButton()

    expect(view.getByRole('button', { name: 'Retry' }).query()).toBeNull()
    await expect
      .element(view.getByRole('button', { name: 'Discard', exact: true }))
      .toBeInTheDocument()
  })
})
