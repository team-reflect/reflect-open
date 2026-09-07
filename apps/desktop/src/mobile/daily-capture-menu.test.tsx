import { render, type RenderResult } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DailyCaptureMenu } from './daily-capture-menu'

const navigate = vi.hoisted(() => vi.fn())
const hapticImpactLight = vi.hoisted(() => vi.fn())
const memo = vi.hoisted(() => ({
  phase: 'idle' as 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error',
  elapsedMs: 0,
  level: 0,
  pendingCount: 0,
  available: true,
  hasTranscriptionConfig: true,
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

vi.mock('@/routing/router', () => ({
  useRouter: () => ({ navigate }),
}))

vi.mock('@/mobile/audio-memo-provider', () => ({
  useMobileAudioMemo: () => ({ ...memo }),
}))

vi.mock('@/mobile/haptics', () => ({
  hapticImpactLight,
}))

function renderMenu(): Promise<RenderResult> {
  return render(<DailyCaptureMenu />)
}

beforeEach(() => {
  vi.clearAllMocks()
  memo.phase = 'idle'
  memo.available = true
  memo.error = null
})

describe('DailyCaptureMenu', () => {
  it('starts collapsed with only the toggle in the accessibility tree', async () => {
    const view = await renderMenu()

    await expect
      .element(view.getByRole('button', { name: 'Show capture actions' }))
      .toHaveAttribute('aria-expanded', 'false')
    expect(view.getByRole('button', { name: 'New note' }).query()).toBeNull()
    expect(view.getByRole('button', { name: 'Record audio memo' }).query()).toBeNull()

    const newNote = view.container.querySelector<HTMLButtonElement>('button[aria-label="New note"]')
    const audioMemo = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Record audio memo"]',
    )
    expect(newNote?.tabIndex).toBe(-1)
    expect(audioMemo?.tabIndex).toBe(-1)
    expect(newNote?.parentElement?.classList.contains('pointer-events-none')).toBe(true)
    expect(audioMemo?.parentElement?.classList.contains('pointer-events-none')).toBe(true)
  })

  it('reveals both actions on the first tap and hides them on the second', async () => {
    const view = await renderMenu()

    await view.getByRole('button', { name: 'Show capture actions' }).click()
    expect(hapticImpactLight).toHaveBeenCalledTimes(1)

    await expect
      .element(view.getByRole('button', { name: 'Hide capture actions' }))
      .toHaveAttribute('aria-expanded', 'true')
    await expect.element(view.getByRole('button', { name: 'New note' })).toBeInTheDocument()
    await expect
      .element(view.getByRole('button', { name: 'Record audio memo' }))
      .toBeInTheDocument()

    await view.getByRole('button', { name: 'Hide capture actions' }).click()
    expect(hapticImpactLight).toHaveBeenCalledTimes(2)

    await expect
      .element(view.getByRole('button', { name: 'Show capture actions' }))
      .toHaveAttribute('aria-expanded', 'false')
    expect(view.getByRole('button', { name: 'New note' }).query()).toBeNull()
    expect(view.getByRole('button', { name: 'Record audio memo' }).query()).toBeNull()
  })

  it('animates the individual translate and scale properties', async () => {
    const view = await renderMenu()
    const newNoteAction = view.container.querySelector<HTMLElement>('[data-slot="new-note-action"]')

    if (!newNoteAction) {
      throw new Error('new-note action was not mounted')
    }
    expect(newNoteAction.className).toContain('transition-[translate,scale,opacity]')
  })

  it('creates an untitled note and collapses', async () => {
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()

    await view.getByRole('button', { name: 'New note' }).click()

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'note', path: expect.stringMatching(/^notes\/.+\.md$/) }),
    )
    await expect
      .element(view.getByRole('button', { name: 'Show capture actions' }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('starts the audio memo and collapses', async () => {
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()

    await view.getByRole('button', { name: 'Record audio memo' }).click()

    expect(memo.toggle).toHaveBeenCalledTimes(1)
    await expect
      .element(view.getByRole('button', { name: 'Show capture actions' }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the current recording, processing, and error states when reopened', async () => {
    const view = await renderMenu()

    memo.phase = 'recording'
    await view.rerender(<DailyCaptureMenu />)
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await expect.element(view.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument()
    await view.getByRole('button', { name: 'Hide capture actions' }).click()

    memo.phase = 'transcribing'
    await view.rerender(<DailyCaptureMenu />)
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await expect
      .element(view.getByRole('button', { name: 'Record audio memo' }))
      .toBeInTheDocument()
    expect(
      view.container.querySelector('[data-slot="audio-memo-action"] .animate-spin'),
    ).not.toBeNull()
    await view.getByRole('button', { name: 'Hide capture actions' }).click()

    memo.phase = 'error'
    memo.error = 'disk full'
    await view.rerender(<DailyCaptureMenu />)
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await expect
      .element(view.getByRole('button', { name: 'Show audio memo error' }))
      .toBeInTheDocument()
  })

  it('reveals only New note when native audio is unavailable', async () => {
    memo.available = false
    const view = await renderMenu()

    await view.getByRole('button', { name: 'Show capture actions' }).click()

    await expect.element(view.getByRole('button', { name: 'New note' })).toBeInTheDocument()
    expect(view.container.querySelector('[data-slot="audio-memo-action"]')).toBeNull()
  })
})
