import { describe, expect, it } from 'vitest'
import { makeOpenTask as task } from '@reflect/core/testing'
import { getTaskMenuItems } from './task-menu.ts'

const TODAY = '2026-06-14'
const TOMORROW = '2026-06-15'

type TaskMenuItem = ReturnType<typeof getTaskMenuItems>[number]

function getActions(items: readonly TaskMenuItem[]): TaskMenuItem[] {
  return items.flatMap((item) => (item.type === 'submenu' ? getActions(item.items) : [item]))
}

function getAction(items: readonly TaskMenuItem[], id: string) {
  return getActions(items).find((item) => item.type === 'action' && item.id === id)
}

function getIds(items: readonly TaskMenuItem[]): string[] {
  return getActions(items)
    .filter((item) => item.type === 'action')
    .map((item) => item.id)
}

describe('getTaskMenuItems', () => {
  it('offers Complete while any target is open, else Reopen', () => {
    const open = task({ astPath: [0] })
    const done = task({ astPath: [1], checked: true })

    expect(getAction(getTaskMenuItems([open, done], TODAY), 'toggle')).toMatchObject({
      title: 'Complete',
    })
    expect(getAction(getTaskMenuItems([done], TODAY), 'toggle')).toMatchObject({ title: 'Reopen' })
  })

  it('checks the preset that every target is due on', () => {
    const items = getTaskMenuItems(
      [task({ astPath: [0], dueDate: TOMORROW }), task({ astPath: [1], dueDate: TOMORROW })],
      TODAY,
    )

    expect(getAction(items, `schedule:${TODAY}`)).toMatchObject({ checked: false })
    expect(getAction(items, `schedule:${TOMORROW}`)).toMatchObject({ checked: true })
  })

  it('checks no preset for targets due on different dates', () => {
    const items = getTaskMenuItems(
      [task({ astPath: [0], dueDate: TODAY }), task({ astPath: [1], dueDate: TOMORROW })],
      TODAY,
    )

    expect(getAction(items, `schedule:${TODAY}`)).toMatchObject({ checked: false })
    expect(getAction(items, `schedule:${TOMORROW}`)).toMatchObject({ checked: false })
  })

  it('disables Clear date when no target has a due date', () => {
    const undated = task({ astPath: [0] })
    const dated = task({ astPath: [1], dueDate: TODAY })

    expect(getAction(getTaskMenuItems([undated], TODAY), 'clear-date')).toMatchObject({
      disabled: true,
    })
    expect(getAction(getTaskMenuItems([undated, dated], TODAY), 'clear-date')).toMatchObject({
      disabled: false,
    })
  })

  it('offers Open note only for targets in one note', () => {
    const a = task({ notePath: 'notes/a.md', astPath: [0] })
    const a2 = task({ notePath: 'notes/a.md', astPath: [1] })
    const b = task({ notePath: 'notes/b.md', astPath: [0] })

    expect(getIds(getTaskMenuItems([a, a2], TODAY))).toContain('open-note')
    expect(getIds(getTaskMenuItems([a, b], TODAY))).not.toContain('open-note')
    expect(getIds(getTaskMenuItems([a, b], TODAY))).not.toContain('open-note-in-new-window')
  })
})
