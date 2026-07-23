import { act, type ReactNode } from 'react'
import { cleanup, render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@/test-utils/fire-event'

const memo = vi.hoisted(() => ({
  phase: 'recording' as 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error',
  elapsedMs: 65_000,
  level: 0.4,
  pendingCount: 0,
  available: true,
  hasTranscriptionConfig: true,
  error: null as string | null,
  canRetry: false,
  drawerOpen: true,
  toggle: vi.fn(),
  stopAndSave: vi.fn(),
  cancelRecording: vi.fn(),
  onDrawerOpenChange: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
}))

vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div data-testid="drawer">{children}</div> : null,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('@/mobile/audio-memo-provider', () => ({
  useMobileAudioMemo: () => ({ ...memo }),
}))

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@/routing/router', () => ({
  useRouter: () => ({ navigate }),
}))

const { RecordingDrawer } = await import('./recording-drawer')

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  memo.phase = 'recording'
  memo.hasTranscriptionConfig = true
  memo.error = null
  memo.drawerOpen = true
})

afterEach(async () => {
  await cleanup()
})
afterEach(() => vi.useRealTimers())

describe('RecordingDrawer', () => {
  it('requires a second tap before discarding a live recording', async () => {
    const view = await render(<RecordingDrawer />)

    await userEvent.click(view.getByRole('button', { name: 'Discard recording' }))

    expect(memo.cancelRecording).not.toHaveBeenCalled()
    await expect
      .element(view.getByRole('button', { name: 'Confirm discard recording' }))
      .toHaveTextContent('Tap again to discard')

    await userEvent.click(view.getByRole('button', { name: 'Confirm discard recording' }))

    expect(memo.cancelRecording).toHaveBeenCalledOnce()
  })

  it('lets the discard confirmation lapse back to a single safe tap', async () => {
    vi.useFakeTimers()
    const view = await render(<RecordingDrawer />)

    await act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Discard recording' }))
    })
    await act(() => {
      vi.advanceTimersByTime(3000)
    })

    await act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Discard recording' }))
    })

    expect(memo.cancelRecording).not.toHaveBeenCalled()
    await expect
      .element(view.getByRole('button', { name: 'Confirm discard recording' }))
      .toBeVisible()
  })

  it('stops and saves from the primary control without confirmation', async () => {
    const view = await render(<RecordingDrawer />)

    await userEvent.click(view.getByRole('button', { name: 'Stop recording' }))

    expect(memo.stopAndSave).toHaveBeenCalledOnce()
  })

  it('without a transcription model, guides key setup instead of recording', async () => {
    memo.hasTranscriptionConfig = false
    const view = await render(<RecordingDrawer />)

    await expect
      .element(view.getByText(/send the recording to OpenAI or Google Gemini/))
      .toBeVisible()
    expect(view.getByRole('button', { name: 'Stop recording' }).query()).toBeNull()

    await userEvent.click(view.getByRole('button', { name: 'Open Settings' }))
    expect(navigate).toHaveBeenCalledWith({ kind: 'settings' })
    expect(memo.onDrawerOpenChange).toHaveBeenCalledWith(false)
  })
})
