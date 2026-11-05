import { createRef, type ReactElement } from 'react'
import { render } from 'vitest-browser-react'
import { describe, expect, it } from 'vitest'
import type { VirtualizerHandle } from 'virtua'
import type { TaskGroup } from '@reflect/core'
import { makeOpenTask } from '@reflect/core/testing'
import { flattenTaskGroups, type TaskListItem } from '@/lib/tasks/task-list-items.ts'
import { scrollTaskIndexIntoView } from '@/lib/tasks/task-navigation.ts'
import { scrollElement } from '@/test-utils/scroll.ts'
import { act } from '@/test-utils/act.ts'
import { findActiveHeader, TaskListVirtualizer } from './task-list-virtualizer.tsx'

const ROW_HEIGHT = 40

/**
 * `count` note groups of 20 tasks each.
 */
function makeGroups(count: number): TaskGroup[] {
  return Array.from({ length: count }, (_, group) => ({
    kind: 'note',
    label: `Note ${group}`,
    notePath: `notes/${group}.md`,
    tasks: Array.from({ length: 20 }, (_, task) => {
      return makeOpenTask({
        notePath: `notes/${group}.md`,
        astPath: [task],
        text: `${group}.${task}`,
      })
    }),
  }))
}

function renderItem(item: TaskListItem): ReactElement {
  return (
    <div key={item.key} data-kind={item.kind} style={{ height: ROW_HEIGHT }}>
      {item.kind === 'header' ? item.group.label : item.kind === 'task' ? item.task.text : null}
    </div>
  )
}

async function renderList({
  groups,
  resetKey = '',
  keepMounted,
}: {
  groups: TaskGroup[]
  resetKey?: string
  keepMounted?: readonly number[]
}) {
  const { items, headerIndexes } = flattenTaskGroups(groups)
  const handle = createRef<VirtualizerHandle>()
  const list = (key: string) => (
    <div data-testid="scroller" style={{ height: 400, overflowY: 'auto' }}>
      <TaskListVirtualizer
        ref={handle}
        items={items}
        headerIndexes={headerIndexes}
        resetKey={key}
        itemSize={ROW_HEIGHT}
        bufferSize={0}
        keepMounted={keepMounted}
      >
        {renderItem}
      </TaskListVirtualizer>
    </div>
  )
  const view = await render(list(resetKey))
  const scroller = view.getByTestId('scroller').element() as HTMLElement
  await expect.poll(() => scroller.querySelectorAll('li').length).toBeGreaterThan(0)
  return { view, scroller, handle, rerender: (key: string) => view.rerender(list(key)) }
}

function stuckLabel(scroller: HTMLElement): string | null {
  const stuck = [...scroller.querySelectorAll('li')].find((li) => li.style.position === 'sticky')
  return stuck?.textContent ?? null
}

describe('findActiveHeader', () => {
  it('picks the last header at or above the top item', () => {
    expect(findActiveHeader([0, 5, 9], 0)).toBe(0)
    expect(findActiveHeader([0, 5, 9], 7)).toBe(5)
    expect(findActiveHeader([0, 5, 9], 20)).toBe(9)
    expect(findActiveHeader([3], 1)).toBe(-1)
  })
})

describe('TaskListVirtualizer', () => {
  it('mounts only the rows near the viewport', async () => {
    const { scroller } = await renderList({ groups: makeGroups(20) })

    expect(scroller.querySelectorAll('li').length).toBeLessThan(30)
  })

  it('sticks the current group header to the top', async () => {
    const { scroller } = await renderList({ groups: makeGroups(5) })
    expect(stuckLabel(scroller)).toBe('Note 0')

    // Group 1's header is item 21; scroll into its tasks.
    await scrollElement({ element: scroller, top: 25 * ROW_HEIGHT })

    await expect.poll(() => stuckLabel(scroller)).toBe('Note 1')
    const stuck = [...scroller.querySelectorAll('li')].find((li) => li.style.position === 'sticky')!
    expect(stuck.getBoundingClientRect().top).toBe(scroller.getBoundingClientRect().top)
  })

  it('keeps requested rows mounted while far off screen', async () => {
    const { scroller } = await renderList({ groups: makeGroups(20), keepMounted: [300] })

    const texts = [...scroller.querySelectorAll('li')].map((li) => li.textContent)
    expect(texts).toContain('14.5')
  })

  it('scrolls back to the top when the reset key changes', async () => {
    const { scroller, rerender } = await renderList({ groups: makeGroups(5), resetKey: 'a' })
    await scrollElement({ element: scroller, top: 50 * ROW_HEIGHT })

    await rerender('b')

    await expect.poll(() => scroller.scrollTop).toBe(0)
    await expect.poll(() => stuckLabel(scroller)).toBe('Note 0')
  })
})

describe('scrollTaskIndexIntoView', () => {
  it('brings a far row into view below the stuck header, and leaves a visible one alone', async () => {
    const { scroller, handle } = await renderList({ groups: makeGroups(5) })

    await act(() => scrollTaskIndexIntoView(handle.current!, 60, ROW_HEIGHT))
    await expect.poll(() => scroller.scrollTop).toBe(61 * ROW_HEIGHT - 400)

    const before = scroller.scrollTop
    await act(() => scrollTaskIndexIntoView(handle.current!, 58, ROW_HEIGHT))
    expect(scroller.scrollTop).toBe(before)

    await act(() => scrollTaskIndexIntoView(handle.current!, 30, ROW_HEIGHT))
    await expect.poll(() => scroller.scrollTop).toBe(29 * ROW_HEIGHT)
  })
})
