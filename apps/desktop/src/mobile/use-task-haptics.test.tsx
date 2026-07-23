import { renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hapticImpactLight } from '@/mobile/haptics'
import { useTaskCheckboxHaptics } from './use-task-haptics'

vi.mock('@/mobile/haptics', () => ({
  hapticImpactLight: vi.fn(),
}))

/** The DOM shape meowdown/prosemirror-flat-list renders for list markers. */
function installList(kind: 'task' | 'toggle', editable = true): HTMLInputElement {
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', editable ? 'true' : 'false')
  const list = document.createElement('div')
  list.className = 'prosemirror-flat-list'
  list.setAttribute('data-list-kind', kind)
  const marker = document.createElement('div')
  marker.className = 'list-marker list-marker-click-target'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  marker.appendChild(checkbox)
  list.appendChild(marker)
  editor.appendChild(list)
  document.body.appendChild(editor)
  return checkbox
}

function press(element: Element): void {
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
}

beforeEach(() => {
  vi.mocked(hapticImpactLight).mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useTaskCheckboxHaptics', () => {
  it('fires a light impact when a task checkbox is pressed', async () => {
    const checkbox = installList('task')
    const view = await renderHook(() => useTaskCheckboxHaptics())
    press(checkbox)
    expect(hapticImpactLight).toHaveBeenCalledOnce()
    await view.unmount()
  })

  it('stays silent for non-task list markers (toggle folds)', async () => {
    const checkbox = installList('toggle')
    const view = await renderHook(() => useTaskCheckboxHaptics())
    press(checkbox)
    expect(hapticImpactLight).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('stays silent outside a live editing surface (protected notes)', async () => {
    const checkbox = installList('task', false)
    const view = await renderHook(() => useTaskCheckboxHaptics())
    press(checkbox)
    expect(hapticImpactLight).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('stays silent for presses outside any list marker', async () => {
    const view = await renderHook(() => useTaskCheckboxHaptics())
    press(document.body)
    expect(hapticImpactLight).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('stops listening after unmount', async () => {
    const checkbox = installList('task')
    const view = await renderHook(() => useTaskCheckboxHaptics())
    await view.unmount()
    press(checkbox)
    expect(hapticImpactLight).not.toHaveBeenCalled()
  })
})
