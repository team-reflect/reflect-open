import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPlatformSurface } from '@/lib/platform-surface'
import { FormattingToolbarBridge } from './formatting-toolbar-bridge'
import { useFormattingToolbar } from './formatting-toolbar-store'

/**
 * The bridge publishes a focused editor's command surface and `canExec`
 * capabilities to the formatting-toolbar store, and keeps them fresh across
 * caret moves and its own commands. The ProseKit editor is faked: `canExec`
 * results are the fixture knobs, and command dispatch is observed directly.
 */

interface FakeCommand {
  (...args: unknown[]): void
  canExec: ReturnType<typeof vi.fn>
}

function makeCommand(): FakeCommand {
  return Object.assign(vi.fn(), { canExec: vi.fn(() => true) })
}

function makeFakeEditor() {
  const dom = document.createElement('div')
  document.body.appendChild(dom)
  return {
    mounted: true,
    focused: false,
    blur: vi.fn(),
    view: { dom },
    commands: {
      toggleList: makeCommand(),
      indentList: makeCommand(),
      dedentList: makeCommand(),
      moveList: makeCommand(),
      insertTrigger: makeCommand(),
    },
  }
}

const fake = vi.hoisted(() => ({ editor: null as unknown }))

vi.mock('@meowdown/react', () => ({
  useEditor: () => fake.editor,
}))

let editor: ReturnType<typeof makeFakeEditor>

beforeEach(() => {
  setPlatformSurface({ touchEditor: true })
  editor = makeFakeEditor()
  fake.editor = editor
})

afterEach(() => {
  cleanup()
  editor.view.dom.remove()
  setPlatformSurface({ touchEditor: false })
  vi.clearAllMocks()
})

function focusIn(): void {
  act(() => {
    editor.focused = true
    editor.view.dom.dispatchEvent(new Event('focusin', { bubbles: true }))
  })
}

describe('FormattingToolbarBridge', () => {
  it('publishes commands and capabilities when the editor gains focus', () => {
    const store = renderHook(() => useFormattingToolbar())
    render(<FormattingToolbarBridge />)
    expect(store.result.current).toBeNull()

    editor.commands.dedentList.canExec.mockReturnValue(false)
    focusIn()

    const toolbar = store.result.current
    expect(toolbar).not.toBeNull()
    expect(toolbar?.capabilities).toEqual({
      canIndent: true,
      canDedent: false,
      canMoveUp: true,
      canMoveDown: true,
    })
    expect(editor.commands.moveList.canExec).toHaveBeenCalledWith('up')
    expect(editor.commands.moveList.canExec).toHaveBeenCalledWith('down')
  })

  it('does nothing off the touch surface', () => {
    setPlatformSurface({ touchEditor: false })
    const store = renderHook(() => useFormattingToolbar())
    render(<FormattingToolbarBridge />)
    focusIn()
    expect(store.result.current).toBeNull()
  })

  it('publishes immediately when the editor is already focused on mount (autoFocus arrivals)', () => {
    editor.focused = true
    const store = renderHook(() => useFormattingToolbar())
    render(<FormattingToolbarBridge />)
    expect(store.result.current).not.toBeNull()
  })

  it('recomputes capabilities on selectionchange while focused, and only then', () => {
    const store = renderHook(() => useFormattingToolbar())
    render(<FormattingToolbarBridge />)
    focusIn()
    const before = store.result.current

    editor.commands.indentList.canExec.mockReturnValue(false)
    act(() => document.dispatchEvent(new Event('selectionchange')))
    expect(store.result.current).not.toBe(before)
    expect(store.result.current?.capabilities.canIndent).toBe(false)

    // Blurred editors ignore selection churn elsewhere in the page.
    act(() => {
      editor.focused = false
      editor.view.dom.dispatchEvent(new Event('focusout', { bubbles: true }))
    })
    expect(store.result.current).toBeNull()
    act(() => document.dispatchEvent(new Event('selectionchange')))
    expect(store.result.current).toBeNull()
  })

  it('runs editor commands and refreshes capabilities after each', () => {
    const store = renderHook(() => useFormattingToolbar())
    render(<FormattingToolbarBridge />)
    focusIn()
    const commands = store.result.current!.commands

    commands.toggleBulletList()
    expect(editor.commands.toggleList).toHaveBeenCalledWith({ kind: 'bullet' })
    commands.toggleTaskList()
    expect(editor.commands.toggleList).toHaveBeenCalledWith({ kind: 'task' })
    commands.indent()
    expect(editor.commands.indentList).toHaveBeenCalledWith()
    commands.dedent()
    expect(editor.commands.dedentList).toHaveBeenCalledWith()
    commands.moveUp()
    expect(editor.commands.moveList).toHaveBeenCalledWith('up')

    // A structural command can change enablement without moving the DOM
    // selection, so the run itself must republish.
    editor.commands.dedentList.canExec.mockReturnValue(false)
    act(() => commands.moveDown())
    expect(editor.commands.moveList).toHaveBeenCalledWith('down')
    expect(store.result.current?.capabilities.canDedent).toBe(false)
  })

  it("types autocomplete triggers through the editor's insertTrigger command", () => {
    const store = renderHook(() => useFormattingToolbar())
    render(<FormattingToolbarBridge />)
    focusIn()

    store.result.current!.commands.insertTrigger('[[')
    expect(editor.commands.insertTrigger).toHaveBeenCalledWith('[[')
  })

  it('dismisses the keyboard by blurring the editor', () => {
    const store = renderHook(() => useFormattingToolbar())
    render(<FormattingToolbarBridge />)
    focusIn()

    store.result.current!.commands.dismissKeyboard()
    expect(editor.blur).toHaveBeenCalled()
  })

  it('clears its published toolbar on unmount', () => {
    const store = renderHook(() => useFormattingToolbar())
    const view = render(<FormattingToolbarBridge />)
    focusIn()
    expect(store.result.current).not.toBeNull()

    view.unmount()
    expect(store.result.current).toBeNull()
  })
})
