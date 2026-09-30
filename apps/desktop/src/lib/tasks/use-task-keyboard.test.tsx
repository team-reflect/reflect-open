import { act } from 'react'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@reflect/core'
import type { TaskCommands } from './use-task-commands.ts'
import { MOD_KEY } from '@/test-utils/mod-key.ts'
import type { ListSelection as TaskSelection } from '@/lib/selection/use-list-selection.ts'
import { useTaskKeyboard } from './use-task-keyboard.ts'

function makeSelection(over: Partial<TaskSelection> = {}): TaskSelection {
  return {
    selected: new Set<string>(),
    selectedCount: 0,
    isSelected: () => false,
    isSoleSelected: () => false,
    clickSelect: vi.fn(),
    select: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
    move: vi.fn(),
    extend: vi.fn(),
    activeKey: () => null,
    ...over,
  }
}

function makeCommands(over: Partial<TaskCommands> = {}): TaskCommands {
  return {
    continue: vi.fn(),
    complete: vi.fn(),
    check: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    removeEmpty: vi.fn(),
    convert: vi.fn(),
    schedule: vi.fn(),
    navigate: vi.fn(),
    cancel: vi.fn(),
    archive: vi.fn(),
    ...over,
  }
}

let root: HTMLDivElement
beforeEach(() => {
  root = document.createElement('div')
  document.body.appendChild(root)
})
afterEach(() => {
  // Unmount each hook so its document keydown listener is removed — otherwise a
  // prior test's handler runs first, preventDefaults, and the next bails on it.
  cleanup()
  root.remove()
})

async function mount(options: {
  selection?: TaskSelection
  commands?: TaskCommands
  orderedTasks?: Task[]
  query?: string
  today?: string
}) {
  const selection = options.selection ?? makeSelection()
  const commands = options.commands ?? makeCommands()
  const setQuery = vi.fn()
  const onToggleFilters = vi.fn()
  const onToggleSchedule = vi.fn()
  await renderHook(() =>
    useTaskKeyboard({
      selection,
      commands,
      query: options.query ?? '',
      setQuery,
      rootRef: { current: root },
      onToggleFilters,
      onToggleSchedule,
    }),
  )
  return { selection, commands, setQuery, onToggleFilters, onToggleSchedule }
}

function press(
  target: EventTarget,
  key: string,
  mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...mods,
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

describe('useTaskKeyboard', () => {
  it('selects all on ⌘A and moves / extends with the arrows', async () => {
    const { selection, commands } = await mount({})
    const a = press(root, 'a', MOD_KEY)
    expect(selection.selectAll).toHaveBeenCalled()
    expect(a.defaultPrevented).toBe(true)

    press(root, 'ArrowDown')
    expect(commands.navigate).toHaveBeenCalledWith(1, false)
    press(root, 'ArrowUp')
    expect(commands.navigate).toHaveBeenCalledWith(-1, false)
    press(root, 'ArrowDown', { shiftKey: true })
    expect(commands.navigate).toHaveBeenCalledWith(1, true)
  })

  it('works when nothing is focused (the body is on-surface)', async () => {
    const { selection } = await mount({})
    press(document.body, 'a', MOD_KEY)
    expect(selection.selectAll).toHaveBeenCalled()
  })

  it('toggles the resolved selection on ⌘↵ and deletes it on ⌘⌫', async () => {
    const selection = makeSelection({
      selected: new Set(['k']),
      selectedCount: 1,
    })
    const { commands } = await mount({ selection })

    press(root, 'Enter', MOD_KEY)
    expect(commands.complete).toHaveBeenCalledWith()

    press(root, 'Backspace', MOD_KEY)
    expect(commands.remove).toHaveBeenCalledWith()
  })

  it('archives on ⌘⇧↵ instead of toggling', async () => {
    const { commands } = await mount({})
    press(root, 'Enter', { ...MOD_KEY, shiftKey: true })
    expect(commands.archive).toHaveBeenCalled()
    expect(commands.complete).not.toHaveBeenCalled()
  })

  it('toggles the filters menu on ⌘⇧E, even from the search box', async () => {
    const input = document.createElement('input')
    root.appendChild(input)
    const { onToggleFilters } = await mount({})
    press(root, 'e', { ...MOD_KEY, shiftKey: true })
    expect(onToggleFilters).toHaveBeenCalledTimes(1)
    // Fires regardless of focus (it's a screen-level chord).
    press(input, 'e', { ...MOD_KEY, shiftKey: true })
    expect(onToggleFilters).toHaveBeenCalledTimes(2)
  })

  it('opens the schedule calendar on ⌘⇧S only when something is selected', async () => {
    const withNone = await mount({ selection: makeSelection({ selectedCount: 0 }) })
    const noneEvent = press(root, 's', { ...MOD_KEY, shiftKey: true })
    expect(withNone.onToggleSchedule).not.toHaveBeenCalled()
    expect(noneEvent.defaultPrevented).toBe(false)

    const withSel = await mount({ selection: makeSelection({ selectedCount: 2 }) })
    const selEvent = press(root, 's', { ...MOD_KEY, shiftKey: true })
    expect(withSel.onToggleSchedule).toHaveBeenCalledTimes(1)
    expect(selEvent.defaultPrevented).toBe(true)
  })

  it('converts the selection to bullets on ⌘⇧K only when something is selected', async () => {
    const withNone = await mount({ selection: makeSelection({ selectedCount: 0 }) })
    const noneEvent = press(root, 'k', { ...MOD_KEY, shiftKey: true })
    expect(withNone.commands.convert).not.toHaveBeenCalled()
    expect(noneEvent.defaultPrevented).toBe(false)

    const withSel = await mount({ selection: makeSelection({ selectedCount: 2 }) })
    const selEvent = press(root, 'k', { ...MOD_KEY, shiftKey: true })
    expect(withSel.commands.convert).toHaveBeenCalledTimes(1)
    expect(selEvent.defaultPrevented).toBe(true)
  })

  it('backs off ⌘⇧K while the inline editor is focused (it handles convert itself)', async () => {
    const editor = document.createElement('div')
    editor.setAttribute('data-task-editor', '')
    root.appendChild(editor)
    const selection = makeSelection({
      selected: new Set(['k']),
      selectedCount: 1,
    })
    const { commands } = await mount({
      selection,
    })

    press(editor, 'k', { ...MOD_KEY, shiftKey: true })
    // The editor's own keymap flushes the draft then converts — the screen handler
    // must not also fire (that's the data-loss race Bugbot flagged).
    expect(commands.convert).not.toHaveBeenCalled()
  })

  it('plain ⌫ asks to remove a sole selected row, never a multi-selection (V1)', async () => {
    const sole = await mount({ selection: makeSelection({ selectedCount: 1 }) })
    const event = press(root, 'Backspace')
    expect(sole.commands.removeEmpty).toHaveBeenCalledWith()
    expect(event.defaultPrevented).toBe(true)

    const many = await mount({ selection: makeSelection({ selectedCount: 2 }) })
    press(root, 'Backspace')
    expect(many.commands.removeEmpty).not.toHaveBeenCalled()
    expect(many.commands.remove).not.toHaveBeenCalled()
  })

  it('Escape clears the selection and the search query together (V1)', async () => {
    const { selection, setQuery } = await mount({
      selection: makeSelection({ selectedCount: 1 }),
      query: 'milk',
    })
    press(root, 'Escape')
    expect(selection.clear).toHaveBeenCalled()
    expect(setQuery).toHaveBeenCalledWith('')
  })

  it('leaves Escape for other handlers when nothing is selected and the query is empty', async () => {
    const { selection } = await mount({
      selection: makeSelection({ selectedCount: 0 }),
      query: '',
    })
    const event = press(root, 'Escape')
    expect(event.defaultPrevented).toBe(false)
    expect(selection.clear).not.toHaveBeenCalled()
  })

  it('ignores keys a focused widget already handled (defaultPrevented)', async () => {
    const { selection } = await mount({})
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      ...MOD_KEY,
      bubbles: true,
      cancelable: true,
    })
    event.preventDefault() // a portaled menu handled it first
    act(() => {
      root.dispatchEvent(event)
    })
    expect(selection.selectAll).not.toHaveBeenCalled()
  })

  it('ignores keys from a portaled overlay (the filters menu)', async () => {
    const { selection } = await mount({})
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('div')
    menu.appendChild(item)
    document.body.appendChild(menu)
    press(item, 'a', MOD_KEY)
    expect(selection.selectAll).not.toHaveBeenCalled()
    menu.remove()
  })

  it('backs off when focus is outside the Tasks surface (the workspace sidebar)', async () => {
    const { selection } = await mount({})
    // A focused control in another panel keeps its own keys — the shortcuts must
    // not reach across to the task list. (The surface is focused on mount, so the
    // shortcuts still work the moment you're on Tasks; see the body test above.)
    const sidebarButton = document.createElement('button')
    document.body.appendChild(sidebarButton)
    press(sidebarButton, 'a', MOD_KEY)
    expect(selection.selectAll).not.toHaveBeenCalled()
    sidebarButton.remove()
  })

  it('Return continues the entry from the list', async () => {
    const { commands } = await mount({ selection: makeSelection({ selectedCount: 1 }) })
    const event = press(root, 'Enter')
    expect(event.defaultPrevented).toBe(true)
    expect(commands.continue).toHaveBeenCalledWith()
  })

  it('backs off entirely while the inline editor is focused', async () => {
    const editor = document.createElement('div')
    editor.setAttribute('data-task-editor', '')
    root.appendChild(editor)
    const selection = makeSelection({
      selected: new Set(['k']),
      selectedCount: 1,
    })
    const { commands } = await mount({
      selection,
    })

    press(editor, 'Backspace', MOD_KEY)
    press(editor, 'a', MOD_KEY)
    expect(commands.remove).not.toHaveBeenCalled()
    expect(selection.selectAll).not.toHaveBeenCalled()
  })

  it('in the search box, only Escape acts', async () => {
    const input = document.createElement('input')
    root.appendChild(input)
    const { selection, setQuery } = await mount({
      selection: makeSelection({ selectedCount: 1 }),
    })

    press(input, 'a', MOD_KEY)
    expect(selection.selectAll).not.toHaveBeenCalled()

    press(input, 'Escape')
    expect(setQuery).toHaveBeenCalledWith('')
    expect(selection.clear).toHaveBeenCalled()
  })
})
