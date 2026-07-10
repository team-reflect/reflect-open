import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearFormattingToolbar,
  publishFormattingToolbar,
  type FormattingToolbar,
} from '@/editor/formatting-toolbar-store'
import { MobileFormattingToolbar } from './formatting-toolbar'

vi.mock('@/mobile/haptics', () => ({ hapticImpactLight: vi.fn() }))

function makeToolbar(
  capabilities: Partial<FormattingToolbar['capabilities']> = {},
): FormattingToolbar {
  return {
    capabilities: {
      canIndent: true,
      canDedent: true,
      canMoveUp: true,
      canMoveDown: true,
      ...capabilities,
    },
    commands: {
      toggleBulletList: vi.fn(),
      cycleCheckableList: vi.fn(),
      indent: vi.fn(),
      dedent: vi.fn(),
      moveUp: vi.fn(),
      moveDown: vi.fn(),
      insertTrigger: vi.fn(),
      dismissKeyboard: vi.fn(),
      scrollCaretIntoView: vi.fn(),
    },
  }
}

const owner = Symbol('toolbar-test')

afterEach(() => {
  cleanup()
  clearFormattingToolbar(owner)
  vi.clearAllMocks()
})

describe('MobileFormattingToolbar', () => {
  it('renders nothing while no editor is focused (the search keyboard case)', () => {
    const view = render(<MobileFormattingToolbar />)
    expect(view.container.firstChild).toBeNull()
  })

  it('renders V1 item order plus the dismiss button, with canExec-driven enablement', () => {
    const toolbar = makeToolbar({ canDedent: false, canMoveUp: false })
    render(<MobileFormattingToolbar />)
    act(() => publishFormattingToolbar(owner, toolbar))

    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Slash command',
      'Bullet list',
      'Cycle checklist and task',
      'Link note',
      'Tag',
      'Outdent',
      'Indent',
      'Move up',
      'Move down',
      'Hide keyboard',
    ])
    expect((screen.getByRole('button', { name: 'Outdent' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: 'Indent' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('never lets a tap move focus out of the editor', () => {
    render(<MobileFormattingToolbar />)
    act(() => publishFormattingToolbar(owner, makeToolbar()))

    const bullet = screen.getByRole('button', { name: 'Bullet list' })
    // fireEvent returns false when a handler called preventDefault — the
    // contract that keeps the editor focused (and the keyboard up) mid-tap.
    expect(fireEvent.pointerDown(bullet)).toBe(false)
    expect(fireEvent.mouseDown(bullet)).toBe(false)
  })

  it('routes taps to the published commands', () => {
    const toolbar = makeToolbar()
    render(<MobileFormattingToolbar />)
    act(() => publishFormattingToolbar(owner, toolbar))

    fireEvent.click(screen.getByRole('button', { name: 'Bullet list' }))
    expect(toolbar.commands.toggleBulletList).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Cycle checklist and task' }))
    expect(toolbar.commands.cycleCheckableList).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Link note' }))
    expect(toolbar.commands.insertTrigger).toHaveBeenCalledWith('[[')

    fireEvent.click(screen.getByRole('button', { name: 'Tag' }))
    expect(toolbar.commands.insertTrigger).toHaveBeenCalledWith('#')

    fireEvent.click(screen.getByRole('button', { name: 'Slash command' }))
    expect(toolbar.commands.insertTrigger).toHaveBeenCalledWith('/')

    fireEvent.click(screen.getByRole('button', { name: 'Hide keyboard' }))
    expect(toolbar.commands.dismissKeyboard).toHaveBeenCalledOnce()
  })
})
