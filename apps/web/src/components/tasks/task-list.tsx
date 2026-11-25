import {
  createContext,
  Fragment,
  use,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type Ref,
  type RefObject,
} from 'react'
import { isDeepEqual } from '@ocavue/utils'
import type { TaskGroup } from '@reflect/core'
import { Virtualizer, type CustomItemComponentProps, type VirtualizerHandle } from 'virtua'
import {
  flattenTaskGroups,
  type TaskListItem,
  type TaskListRow,
} from '@/lib/tasks/task-list-items.ts'

/**
 * Height (px) of a group header.
 */
const HEADER_HEIGHT = 32

/**
 * How far (px) past the viewport rows stay mounted.
 */
const ROW_BUFFER = 640

/**
 * How far (px) past the viewport a group keeps its header mounted. A header
 * is one small item, so it mounts long before its rows do.
 */
const HEADER_BUFFER = 2000

export interface TaskListHandle {
  /**
   * Scrolls the row of a task into view, below the stuck group header. Does
   * nothing when the row is in view, or the list holds no such task.
   */
  revealTask: (taskId: string) => void
}

interface TaskListProps {
  ref?: Ref<TaskListHandle> | undefined
  /**
   * The scroll container. The list is its first content.
   */
  scrollRef: RefObject<HTMLElement | null>
  groups: readonly TaskGroup[]
  /**
   * Remounts the list at the top when it changes. Pass the search text and filters.
   */
  resetKey: string
  /**
   * Size hint (px) for rows not measured yet: a single-line task row.
   */
  rowHeight: number
  /**
   * Space (px) under the last row of each group.
   */
  groupGap?: number | undefined
  /**
   * A task whose row stays mounted out of view, e.g. the one being edited.
   */
  keepMountedTaskId?: string | null | undefined
  /**
   * Renders a group header. It fills the header slot.
   */
  renderHeader: (group: TaskGroup) => ReactElement
  renderRow: (row: TaskListRow) => ReactElement
}

/**
 * The virtualized list of task groups. A group header sticks to the top while
 * its group is in view: the header item holds a track as tall as the group,
 * and the header is sticky inside the track.
 */
export function TaskList({ resetKey, ...props }: TaskListProps): ReactElement {
  const { scrollRef } = props
  const resetKeyRef = useRef(resetKey)
  // The scroll container outlives a remount, so a new list starts at the top.
  useLayoutEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey
      scrollRef.current?.scrollTo({ top: 0 })
    }
  }, [resetKey, scrollRef])
  return <GroupedTaskList key={resetKey} {...props} />
}

/**
 * The items of the list and the space under each group, for an item's element.
 */
interface ItemLayout {
  items: readonly TaskListItem[]
  groupGap: number
}

const ItemLayoutContext = createContext<ItemLayout>({ items: [], groupGap: 0 })

function TaskListItemElement({
  style,
  index,
  children,
  ref,
}: CustomItemComponentProps): ReactElement {
  const { items, groupGap } = use(ItemLayoutContext)
  const item = items[index]
  const isHeader = item?.kind === 'header'
  const isGroupEnd = item?.kind === 'task' && item.groupEnd
  const itemStyle = useMemo((): CSSProperties => {
    return {
      ...style,
      // A header reaches out of its item, over the rows of its group.
      ...(isHeader ? { zIndex: 1 } : undefined),
      ...(isGroupEnd ? { paddingBottom: groupGap } : undefined),
    }
  }, [style, isHeader, isGroupEnd, groupGap])
  return (
    <li ref={ref} style={itemStyle}>
      {children}
    </li>
  )
}

interface GroupTracksOptions {
  virtualizerRef: RefObject<VirtualizerHandle | null>
  /**
   * The element whose height is the height of the list.
   */
  listRef: RefObject<HTMLElement | null>
  headerIndexes: readonly number[]
  groupGap: number
}

interface GroupTracks {
  /**
   * The height (px) of each group near the viewport, by the index of its
   * header item.
   */
  heights: ReadonlyMap<number, number>
  /**
   * Reads the groups near the viewport again.
   */
  update: () => void
}

/**
 * Tracks the groups near the viewport and how tall each is. The heights
 * follow the scroll position and the measured sizes of the rows.
 */
function useGroupTracks({
  virtualizerRef,
  listRef,
  headerIndexes,
  groupGap,
}: GroupTracksOptions): GroupTracks {
  const [heights, setHeights] = useState<ReadonlyMap<number, number>>(() => new Map())

  const update = useCallback(() => {
    const virtualizer = virtualizerRef.current
    if (virtualizer === null) {
      return
    }
    const start = virtualizer.scrollOffset - HEADER_BUFFER
    const end = virtualizer.scrollOffset + virtualizer.viewportSize + HEADER_BUFFER
    const next = new Map<number, number>()
    for (const [position, index] of headerIndexes.entries()) {
      const top = virtualizer.getItemOffset(index)
      if (top > end) {
        break
      }
      const nextIndex = headerIndexes[position + 1]
      const bottom =
        nextIndex === undefined ? virtualizer.scrollSize : virtualizer.getItemOffset(nextIndex)
      if (bottom >= start) {
        next.set(index, bottom - top - groupGap)
      }
    }
    setHeights((current) => (isDeepEqual([...current], [...next]) ? current : next))
  }, [virtualizerRef, headerIndexes, groupGap])

  // A measured row moves the rows after it, which changes the list's height.
  useLayoutEffect(() => {
    update()
    const list = listRef.current
    if (list === null) {
      return
    }
    const observer = new ResizeObserver(update)
    observer.observe(list)
    return () => observer.disconnect()
  }, [update, listRef])

  return { heights, update }
}

function GroupedTaskList({
  ref,
  scrollRef,
  groups,
  rowHeight,
  groupGap = 0,
  keepMountedTaskId,
  renderHeader,
  renderRow,
}: Omit<TaskListProps, 'resetKey'>): ReactElement {
  const virtualizerRef = useRef<VirtualizerHandle>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const { items, headerIndexes, indexByTaskId } = useMemo(() => flattenTaskGroups(groups), [groups])
  const layout = useMemo(() => ({ items, groupGap }), [items, groupGap])
  const tracks = useGroupTracks({ virtualizerRef, listRef, headerIndexes, groupGap })

  const keepMountedIndex =
    keepMountedTaskId == null ? undefined : indexByTaskId.get(keepMountedTaskId)
  const keepMounted = useMemo(() => {
    const indexes = [...tracks.heights.keys()]
    return keepMountedIndex === undefined ? indexes : [...indexes, keepMountedIndex]
  }, [tracks.heights, keepMountedIndex])

  useImperativeHandle(ref, () => {
    return {
      revealTask: (taskId) => {
        const virtualizer = virtualizerRef.current
        const index = indexByTaskId.get(taskId)
        if (virtualizer === null || index === undefined) {
          return
        }
        const top = virtualizer.getItemOffset(index)
        const bottom = top + virtualizer.getItemSize(index)
        if (top < virtualizer.scrollOffset + HEADER_HEIGHT) {
          virtualizer.scrollToIndex(index, { align: 'start', offset: -HEADER_HEIGHT })
        } else if (bottom > virtualizer.scrollOffset + virtualizer.viewportSize) {
          virtualizer.scrollToIndex(index, { align: 'end' })
        }
      },
    }
  }, [indexByTaskId])

  return (
    <div ref={listRef}>
      <ItemLayoutContext value={layout}>
        <Virtualizer
          ref={virtualizerRef}
          scrollRef={scrollRef}
          as="ul"
          item={TaskListItemElement}
          data={items}
          itemSize={rowHeight}
          bufferSize={ROW_BUFFER}
          keepMounted={keepMounted}
          onScroll={tracks.update}
        >
          {(item, index) => {
            if (item.kind !== 'header') {
              return <Fragment key={item.key}>{renderRow(item)}</Fragment>
            }
            return (
              <div key={item.key} style={{ height: HEADER_HEIGHT }}>
                <div
                  className="pointer-events-none absolute inset-x-0 top-0"
                  style={{ height: tracks.heights.get(index) }}
                >
                  <div
                    className="pointer-events-auto sticky top-0"
                    style={{ height: HEADER_HEIGHT }}
                  >
                    {renderHeader(item.group)}
                  </div>
                </div>
              </div>
            )
          }}
        </Virtualizer>
      </ItemLayoutContext>
    </div>
  )
}
