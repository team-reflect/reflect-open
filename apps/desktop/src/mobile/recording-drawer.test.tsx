import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

afterEach(cleanup)
afterEach(() => vi.useRealTimers())

describe('RecordingDrawer', () => {
  it('requires a second tap before discarding a live recording', async () => {
    const user = userEvent.setup()
    const view = render(<RecordingDrawer />)

    await user.click(view.getByRole('button', { name: 'Discard recording' }))

    expect(memo.cancelRecording).not.toHaveBeenCalled()
    expect(
      view.getByRole('button', { name: 'Confirm discard recording' }).textContent,
    ).toContain('Tap again to discard')

    await user.click(view.getByRole('button', { name: 'Confirm discard recording' }))

    expect(memo.cancelRecording).toHaveBeenCalledOnce()
  })

  it('lets the discard confirmation lapse back to a single safe tap', async () => {
    vi.useFakeTimers()
    const view = render(<RecordingDrawer />)

    fireEvent.click(view.getByRole('button', { name: 'Discard recording' }))
    act(() => {
      vi.advanceTimersByTime(3000)
    })

    fireEvent.click(view.getByRole('button', { name: 'Discard recording' }))

    expect(memo.cancelRecording).not.toHaveBeenCalled()
    expect(view.getByRole('button', { name: 'Confirm discard recording' })).toBeTruthy()
  })

  it('stops and saves from the primary control without confirmation', async () => {
    const user = userEvent.setup()
    const view = render(<RecordingDrawer />)

    await user.click(view.getByRole('button', { name: 'Stop recording' }))

    expect(memo.stopAndSave).toHaveBeenCalledOnce()
  })

  it('without a transcription model, guides key setup instead of recording', async () => {
    memo.hasTranscriptionConfig = false
    const user = userEvent.setup()
    const view = render(<RecordingDrawer />)

    expect(view.getByText(/send the recording to OpenAI or Google Gemini/)).not.toBeNull()
    expect(view.queryByRole('button', { name: 'Stop recording' })).toBeNull()

    await user.click(view.getByRole('button', { name: 'Open Settings' }))
    expect(navigate).toHaveBeenCalledWith({ kind: 'settings' })
    expect(memo.onDrawerOpenChange).toHaveBeenCalledWith(false)
  })
})
