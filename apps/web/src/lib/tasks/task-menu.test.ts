import { describe, expect, it } from 'vitest'
import type { NativeContextMenuItem } from '@reflect/app'
import { makeOpenTask as task } from '@reflect/core/testing'
import { getTaskMenuItems } from './task-menu.ts'

const TODAY = '2026-06-14'

function getActions(items: readonly NativeContextMenuItem[]): NativeContextMenuItem[] {
  return items.flatMap((item) => (item.type === 'submenu' ? getActions(item.items) : [item]))
}

function getAction(items: readonly NativeContextMenuItem[], id: string) {
  return getActions(items).find((item) => item.type === 'action' && item.id === id)
}

function getIds(items: readonly NativeContextMenuItem[]): string[] {
  return getActions(items)
    .filter((item) => item.type === 'action')
    .map((item) => item.id)
}

describe('getTaskMenuItems', () => {
  it('offers Complete while any target is open, else Reopen', () => {
    const open = task({ astPath: [0] })
    const done = task({ astPath: [1], checked: true })

    expect(getIds(getTaskMenuItems([open, done], TODAY))).toContain('complete')
    expect(getIds(getTaskMenuItems([done], TODAY))).not.toContain('complete')
    expect(getAction(getTaskMenuItems([done], TODAY), 'reopen')).toMatchObject({ title: 'Reopen' })
  })

  it('checks the preset equal to the due date of a single target', () => {
    const items = getTaskMenuItems([task({ dueDate: '2026-06-15' })], TODAY)

    expect(getAction(items, 'today')).toMatchObject({ checked: false })
    expect(getAction(items, 'tomorrow')).toMatchObject({ checked: true })
    expect(getAction(items, 'next-week')).toMatchObject({ checked: false })
  })

  it('checks no preset for several targets', () => {
    const items = getTaskMenuItems(
      [task({ astPath: [0], dueDate: TODAY }), task({ astPath: [1], dueDate: TODAY })],
      TODAY,
    )

    expect(getAction(items, 'today')).toMatchObject({ checked: false })
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
