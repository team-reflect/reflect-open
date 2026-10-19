import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestCoreServices } from '@reflect/core/testing'
import { renderInApp, type InAppRenderResult } from '@/test-utils/render-in-app.tsx'
import { DailyCaptureMenu } from './daily-capture-menu.tsx'
import type { MobileAudioMemoContextValue } from '@/mobile/audio-memo-provider.tsx'
import type { Mutable } from '@reflect/utils'

const memo = vi.hoisted((): Mutable<MobileAudioMemoContextValue> => ({
  phase: 'idle',
  elapsedMs: 0,
  level: 0,
  pendingCount: 0,
  available: true,
  hasTranscriptionConfig: true,
  error: null,
  canRetry: false,
  drawerOpen: false,
  toggle: vi.fn(),
  stopAndSave: vi.fn(),
  cancelRecording: vi.fn(),
  onDrawerOpenChange: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
}))

vi.mock('@/mobile/audio-memo-provider.tsx', () => ({
  useMobileAudioMemo: () => ({ ...memo }),
}))

function renderMenu(): Promise<InAppRenderResult<TestCoreServices>> {
  return renderInApp(<DailyCaptureMenu />)
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
    expect(view.app.mobile.haptics.impacts()).toBe(1)

    await expect
      .element(view.getByRole('button', { name: 'Hide capture actions' }))
      .toHaveAttribute('aria-expanded', 'true')
    await expect.element(view.getByRole('button', { name: 'New note' })).toBeInTheDocument()
    await expect
      .element(view.getByRole('button', { name: 'Record audio memo' }))
      .toBeInTheDocument()

    await view.getByRole('button', { name: 'Hide capture actions' }).click()
    expect(view.app.mobile.haptics.impacts()).toBe(2)

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

    const navigations = view.appServices.navigation.navigations()
    expect(navigations).toHaveLength(1)
    expect(navigations[0]?.route).toMatchObject({
      kind: 'note',
      path: expect.stringMatching(/^notes\/.+\.md$/) as string,
    })
    expect(navigations[0]?.options).toBeUndefined()
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
      .element(view.getByRole('button', { name: 'Record audio memo' }).getByTestId('spinner'))
      .toBeInTheDocument()
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
