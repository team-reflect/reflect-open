import { act } from '@/test-utils/act.ts'
import { userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@/test-utils/fire-event.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { WritableStore, type MobileAudioMemoSessionState } from '@reflect/core'
import { MobileAudioMemoContext } from '@/mobile/audio-memo-provider.tsx'

const INITIAL: MobileAudioMemoSessionState = {
  phase: 'recording',
  pendingCount: 0,
  available: true,
  hasTranscriptionConfig: true,
  error: null,
  canRetry: false,
  drawerOpen: true,
}

const state = new WritableStore(INITIAL)
const elapsedMs = new WritableStore(0)
const level = new WritableStore(0)
const actions = {
  toggle: vi.fn(),
  stopAndSave: vi.fn(),
  cancelRecording: vi.fn(),
  onDrawerOpenChange: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
}
const session = { get: state.get, subscribe: state.subscribe, elapsedMs, level }

function setMemo(patch: Partial<MobileAudioMemoSessionState>): void {
  state.set({ ...state.get(), ...patch })
}

const { RecordingDrawer } = await import('./recording-drawer.tsx')

function renderDrawer(): ReturnType<typeof renderInApp> {
  return renderInApp(
    <MobileAudioMemoContext value={{ session, ...actions }}>
      <RecordingDrawer />
    </MobileAudioMemoContext>,
  )
}

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  state.set(INITIAL)
  elapsedMs.set(65_000)
  level.set(0.4)
})

afterEach(() => vi.useRealTimers())

describe('RecordingDrawer', () => {
  it('counts past an hour: a session has no duration limit', async () => {
    elapsedMs.set(65 * 60_000 + 3000)
    const view = await renderDrawer()

    await expect.element(view.getByText('1:05:03')).toBeVisible()
  })

  it('requires a second tap before discarding a live recording', async () => {
    const view = await renderDrawer()

    await userEvent.click(view.getByRole('button', { name: 'Discard recording' }))

    expect(actions.cancelRecording).not.toHaveBeenCalled()
    await expect
      .element(view.getByRole('button', { name: 'Confirm discard recording' }))
      .toMatchTextContent('Tap again to discard')

    await userEvent.click(view.getByRole('button', { name: 'Confirm discard recording' }))

    expect(actions.cancelRecording).toHaveBeenCalledOnce()
  })

  it('lets the discard confirmation lapse back to a single safe tap', async () => {
    vi.useFakeTimers()
    const view = await renderDrawer()

    await act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Discard recording' }))
    })
    await act(() => {
      vi.advanceTimersByTime(3000)
    })

    await act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Discard recording' }))
    })

    expect(actions.cancelRecording).not.toHaveBeenCalled()
    await expect
      .element(view.getByRole('button', { name: 'Confirm discard recording' }))
      .toBeVisible()
  })

  it('stops and saves from the primary control without confirmation', async () => {
    const view = await renderDrawer()

    await userEvent.click(view.getByRole('button', { name: 'Stop recording' }))

    expect(actions.stopAndSave).toHaveBeenCalledOnce()
  })

  it('without a transcription model, guides key setup instead of recording', async () => {
    setMemo({ hasTranscriptionConfig: false })
    const view = await renderDrawer()

    await expect
      .element(view.getByText(/send the recording to OpenAI or Google Gemini/))
      .toBeVisible()
    expect(view.getByRole('button', { name: 'Stop recording' }).query()).toBeNull()

    await userEvent.click(view.getByRole('button', { name: 'Open Settings' }))
    expect(view.appServices.navigation.navigations()).toEqual([
      { route: { kind: 'settings' }, options: undefined },
    ])
    expect(actions.onDrawerOpenChange).toHaveBeenCalledWith(false)
  })
})
