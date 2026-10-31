import { act } from '@/test-utils/act.ts'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearFormattingToolbar,
  publishFormattingToolbar,
  type FormattingToolbar,
} from '@/editor/formatting-toolbar-store.ts'
import { fireEvent } from '@/test-utils/fire-event.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { MobileFormattingToolbar } from './formatting-toolbar.tsx'

function makeToolbar(
  capabilities: Partial<FormattingToolbar['capabilities']> = {},
): FormattingToolbar {
  return {
    capabilities: {
      canIndent: true,
      canDedent: true,
      canMoveUp: true,
      canMoveDown: true,
      canAttachFiles: true,
      ...capabilities,
    },
    commands: {
      cycleBulletOrderedList: vi.fn(),
      cycleCheckableList: vi.fn(),
      indent: vi.fn(),
      dedent: vi.fn(),
      moveUp: vi.fn(),
      moveDown: vi.fn(),
      insertTrigger: vi.fn(),
      dismissKeyboard: vi.fn(),
      attachFiles: vi.fn(),
      scrollCaretIntoView: vi.fn(),
    },
  }
}

const owner = Symbol('toolbar-test')

afterEach(() => {
  clearFormattingToolbar(owner)
  vi.clearAllMocks()
})

describe('MobileFormattingToolbar', () => {
  it('renders nothing while no editor is focused (the search keyboard case)', async () => {
    const view = await renderInApp(<MobileFormattingToolbar />)
    expect(view.container.firstChild).toBeNull()
  })

  it('renders V1 item order plus the dismiss button, with canExec-driven enablement', async () => {
    const toolbar = makeToolbar({ canDedent: false, canMoveUp: false })
    await renderInApp(<MobileFormattingToolbar />)
    await act(() => publishFormattingToolbar(owner, toolbar))

    const buttons = page.getByRole('button').elements()
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Slash command',
      'Cycle list style',
      'Cycle checklist and task',
      'Link note',
      'Tag',
      'Outdent',
      'Indent',
      'Move up',
      'Move down',
      'Insert image',
      'Hide keyboard',
    ])
    await expect.element(page.getByRole('button', { name: 'Outdent' })).toBeDisabled()
    await expect.element(page.getByRole('button', { name: 'Move up' })).toBeDisabled()
    await expect.element(page.getByRole('button', { name: 'Indent' })).toBeEnabled()
  })

  it('never lets a tap move focus out of the editor', async () => {
    await renderInApp(<MobileFormattingToolbar />)
    await act(() => publishFormattingToolbar(owner, makeToolbar()))

    const bullet = page.getByRole('button', { name: 'Cycle list style' })
    // fireEvent returns false when a handler called preventDefault — the
    // contract that keeps the editor focused (and the keyboard up) mid-tap.
    expect(fireEvent.pointerDown(bullet)).toBe(false)
    expect(fireEvent.mouseDown(bullet)).toBe(false)
  })

  it('routes taps to the published commands', async () => {
    const toolbar = makeToolbar()
    await renderInApp(<MobileFormattingToolbar />)
    await act(() => publishFormattingToolbar(owner, toolbar))

    fireEvent.click(page.getByRole('button', { name: 'Cycle list style' }))
    expect(toolbar.commands.cycleBulletOrderedList).toHaveBeenCalledOnce()

    fireEvent.click(page.getByRole('button', { name: 'Cycle checklist and task' }))
    expect(toolbar.commands.cycleCheckableList).toHaveBeenCalledOnce()

    fireEvent.click(page.getByRole('button', { name: 'Link note' }))
    expect(toolbar.commands.insertTrigger).toHaveBeenCalledWith('[[')

    fireEvent.click(page.getByRole('button', { name: 'Tag' }))
    expect(toolbar.commands.insertTrigger).toHaveBeenCalledWith('#')

    fireEvent.click(page.getByRole('button', { name: 'Slash command' }))
    expect(toolbar.commands.insertTrigger).toHaveBeenCalledWith('/')

    fireEvent.click(page.getByRole('button', { name: 'Hide keyboard' }))
    expect(toolbar.commands.dismissKeyboard).toHaveBeenCalledOnce()
  })

  it('hides the image button for an editor that cannot persist files', async () => {
    await renderInApp(<MobileFormattingToolbar />)
    await act(() => publishFormattingToolbar(owner, makeToolbar({ canAttachFiles: false })))

    expect(page.getByRole('button', { name: 'Insert image' }).query()).toBeNull()
  })

  it('hands the picked images to the editor', async () => {
    // The OS file picker cannot be answered from a test: the input's `click`
    // is where it would open, so the files are chosen there instead.
    const inputs: HTMLInputElement[] = []
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      inputs.push(this)
      const chosen = new DataTransfer()
      chosen.items.add(new File(['png'], 'photo.png', { type: 'image/png' }))
      this.files = chosen.files
      this.dispatchEvent(new Event('change'))
    })
    const toolbar = makeToolbar()
    await renderInApp(<MobileFormattingToolbar />)
    await act(() => publishFormattingToolbar(owner, toolbar))

    fireEvent.click(page.getByRole('button', { name: 'Insert image' }))

    expect(inputs.map((input) => [input.type, input.accept, input.multiple])).toEqual([
      ['file', 'image/*', true],
    ])
    await vi.waitFor(() => {
      expect(toolbar.commands.attachFiles).toHaveBeenCalledOnce()
    })
    const attached = vi.mocked(toolbar.commands.attachFiles).mock.lastCall?.[0] ?? []
    expect(attached.map((file) => [file.name, file.type])).toEqual([['photo.png', 'image/png']])
  })
})
