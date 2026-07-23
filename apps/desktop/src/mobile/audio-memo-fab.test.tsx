import { render, type RenderResult } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const memo = vi.hoisted(() => ({
  phase: 'idle' as 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error',
  elapsedMs: 0,
  level: 0,
  pendingCount: 0,
  available: true,
  error: null as string | null,
  canRetry: false,
  drawerOpen: false,
  toggle: vi.fn(),
  stopAndSave: vi.fn(),
  cancelRecording: vi.fn(),
  onDrawerOpenChange: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
}))

vi.mock('@/mobile/audio-memo-provider', () => ({
  useMobileAudioMemo: () => ({ ...memo }),
}))

const { AudioMemoFab } = await import('./audio-memo-fab')

function renderFab(): Promise<RenderResult> {
  return render(<AudioMemoFab />)
}

beforeEach(() => {
  vi.clearAllMocks()
  memo.phase = 'idle'
  memo.available = true
  memo.error = null
})

describe('AudioMemoFab', () => {
  it('idle records on tap', async () => {
    const view = await renderFab()

    await view.getByRole('button', { name: 'Record audio memo' }).click()

    expect(memo.toggle).toHaveBeenCalledTimes(1)
  })

  it('reads as the stop control while recording', async () => {
    memo.phase = 'recording'
    const view = await renderFab()

    await expect.element(view.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument()
  })

  it('a parked failure reads as the error affordance', async () => {
    memo.phase = 'error'
    memo.error = 'disk full'
    const view = await renderFab()

    await expect
      .element(view.getByRole('button', { name: 'Show audio memo error' }))
      .toBeInTheDocument()
  })

  it('hides entirely when the feature cannot run', async () => {
    memo.available = false
    const view = await renderFab()

    expect(view.getByRole('button').query()).toBeNull()
  })
})
