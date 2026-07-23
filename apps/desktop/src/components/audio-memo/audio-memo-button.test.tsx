import { render, type RenderResult } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

const memo = vi.hoisted(() => ({
  phase: 'idle' as 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error',
  elapsedMs: 0,
  stream: null,
  available: true,
  unavailableReason: null as string | null,
  error: null as string | null,
  canRetry: false,
  toggle: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
}))

vi.mock('@/providers/audio-memo-provider', () => ({
  useAudioMemo: () => ({ ...memo }),
}))

const { AudioMemoButton } = await import('./audio-memo-button')

function renderButton(): Promise<RenderResult> {
  return render(
    <TooltipProvider>
      <AudioMemoButton />
    </TooltipProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  memo.phase = 'idle'
  memo.elapsedMs = 0
  memo.available = true
  memo.unavailableReason = null
  memo.error = null
  memo.canRetry = false
})

describe('AudioMemoButton', () => {
  it('unavailable renders aria-disabled — never natively disabled — and ignores clicks', async () => {
    memo.available = false
    memo.unavailableReason = 'Add an OpenAI or Gemini model in Settings to record audio memos'
    const view = await renderButton()

    // aria-disabled (not `disabled`) keeps pointer events alive so the
    // explanatory tooltip can fire; the reason copy itself is asserted in the
    // provider test.
    const micButton = view.getByRole('button', { name: 'Record audio memo' })
    await expect.element(micButton).toHaveAttribute('aria-disabled', 'true')
    expect(micButton.element()).toHaveProperty('disabled', false)

    // force: playwright refuses to click aria-disabled controls on its own.
    await userEvent.click(micButton, { force: true })
    expect(memo.toggle).not.toHaveBeenCalled()
  })

  it('recording shows the stop control and the elapsed time', async () => {
    memo.phase = 'recording'
    memo.elapsedMs = 83_000
    const view = await renderButton()

    await expect.element(view.getByText('1:23')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Stop recording' }))
    expect(memo.toggle).toHaveBeenCalled()
  })

  it('escape cancels a recording without transcribing', async () => {
    memo.phase = 'recording'
    const view = await renderButton()

    view.getByRole('button', { name: 'Stop recording' }).element().focus()
    await userEvent.keyboard('{Escape}')
    expect(memo.cancel).toHaveBeenCalled()
    expect(memo.toggle).not.toHaveBeenCalled()
  })

  it('escape is inert while transcribing — stopping committed the save', async () => {
    memo.phase = 'transcribing'
    await renderButton()

    await userEvent.keyboard('{Escape}')
    expect(memo.cancel).not.toHaveBeenCalled()
    expect(memo.discard).not.toHaveBeenCalled()
  })

  it('transcribing shows progress while the mic stays live for the next memo', async () => {
    memo.phase = 'transcribing'
    const view = await renderButton()

    await expect.element(view.getByText('Transcribing…')).toBeInTheDocument()
    const micButton = view.getByRole('button', { name: 'Record audio memo' })
    expect(micButton.element()).toHaveProperty('disabled', false)
    await userEvent.click(micButton)
    expect(memo.toggle).toHaveBeenCalled()
  })

  it('a resumable failure offers Retry and Discard', async () => {
    memo.phase = 'error'
    memo.error = 'provider down'
    memo.canRetry = true
    const view = await renderButton()

    await expect.element(view.getByText('provider down')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Retry' }))
    expect(memo.retry).toHaveBeenCalled()
    await userEvent.click(view.getByRole('button', { name: 'Discard', exact: true }))
    expect(memo.discard).toHaveBeenCalled()
  })

  it('a non-resumable failure hides Retry', async () => {
    memo.phase = 'error'
    memo.error = 'came back empty'
    memo.canRetry = false
    const view = await renderButton()

    expect(view.getByRole('button', { name: 'Retry' }).query()).toBeNull()
    await expect
      .element(view.getByRole('button', { name: 'Discard', exact: true }))
      .toBeInTheDocument()
  })
})
