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
import { flattenTaskGroups, type TaskListRow } from '@/lib/tasks/task-list-items.ts'

/**
 * Height (px) of a group header, which `renderHeader` must match: `h-8`.
 */
const HEADER_HEIGHT = 32

/**
 * How far (px) past the viewport a group keeps its header mounted.
 */
const NEAR_BUFFER = 2000

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
  mountedTaskId?: string | null | undefined
  /**
   * Renders a group header, {@link HEADER_HEIGHT} tall.
   */
  renderHeader: (group: TaskGroup) => ReactElement
  renderRow: (row: TaskListRow) => ReactElement
}

/**
 * The virtualized list of task groups, for the desktop and the mobile Tasks
 * screens. A group header sticks to the top while its group is in view: the
 * header item holds a track as tall as the group, and the header is sticky
 * inside the track.
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
 * The header item of a group near the viewport, and how tall (px) the track
 * of its header is.
 */
interface GroupTrack {
  index: number
  height: number
}

/**
 * What an item needs to know about its place in its group.
 */
interface GroupLayout {
  headerIndexes: ReadonlySet<number>
  /**
   * Indexes of the last item of each group.
   */
  groupEndIndexes: ReadonlySet<number>
  groupGap: number
}

const GroupLayoutContext = createContext<GroupLayout>({
  headerIndexes: new Set(),
  groupEndIndexes: new Set(),
  groupGap: 0,
})

function TaskListItem({ style, index, children, ref }: CustomItemComponentProps): ReactElement {
  const { headerIndexes, groupEndIndexes, groupGap } = use(GroupLayoutContext)
  const isHeader = headerIndexes.has(index)
  const isGroupEnd = groupEndIndexes.has(index)
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

function GroupedTaskList({
  ref,
  scrollRef,
  groups,
  rowHeight,
  groupGap = 0,
  mountedTaskId,
  renderHeader,
  renderRow,
}: Omit<TaskListProps, 'resetKey'>): ReactElement {
  const virtualizerRef = useRef<VirtualizerHandle>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [tracks, setTracks] = useState<GroupTrack[]>([])

  const { items, headerIndexes, indexByTaskId } = useMemo(() => flattenTaskGroups(groups), [groups])
  const layout = useMemo((): GroupLayout => {
    const ends = headerIndexes.slice(1).map((index) => index - 1)
    if (items.length > 0) {
      ends.push(items.length - 1)
    }
    return {
      headerIndexes: new Set(headerIndexes),
      groupEndIndexes: new Set(ends),
      groupGap,
    }
  }, [headerIndexes, items.length, groupGap])

  const updateTracks = useCallback(() => {
    const virtualizer = virtualizerRef.current
    if (virtualizer === null) {
      return
    }
    const start = virtualizer.scrollOffset - NEAR_BUFFER
    const end = virtualizer.scrollOffset + virtualizer.viewportSize + NEAR_BUFFER
    const next: GroupTrack[] = []
    for (const [position, index] of headerIndexes.entries()) {
      const top = virtualizer.getItemOffset(index)
      if (top > end) {
        break
      }
      const nextIndex = headerIndexes[position + 1]
      const bottom =
        nextIndex === undefined ? virtualizer.scrollSize : virtualizer.getItemOffset(nextIndex)
      if (bottom >= start) {
        next.push({ index, height: bottom - top - groupGap })
      }
    }
    setTracks((current) => (isDeepEqual(current, next) ? current : next))
  }, [headerIndexes, groupGap])

  // A measured row moves the rows after it, which changes the list's height.
  useLayoutEffect(() => {
    updateTracks()
    const list = listRef.current
    if (list === null) {
      return
    }
    const observer = new ResizeObserver(updateTracks)
    observer.observe(list)
    return () => observer.disconnect()
  }, [updateTracks])

  const mountedIndex = mountedTaskId == null ? undefined : indexByTaskId.get(mountedTaskId)
  const keepMounted = useMemo(() => {
    const indexes = tracks.map((track) => track.index)
    return mountedIndex === undefined ? indexes : [...indexes, mountedIndex]
  }, [tracks, mountedIndex])

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
      <GroupLayoutContext value={layout}>
        <Virtualizer
          ref={virtualizerRef}
          scrollRef={scrollRef}
          as="ul"
          item={TaskListItem}
          data={items}
          itemSize={rowHeight}
          bufferSize={640}
          keepMounted={keepMounted}
          onScroll={updateTracks}
        >
          {(item, index) => {
            if (item.kind !== 'header') {
              return <Fragment key={item.key}>{renderRow(item)}</Fragment>
            }
            const height = tracks.find((track) => track.index === index)?.height
            return (
              <div key={item.key} className="h-8">
                <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height }}>
                  <div className="pointer-events-auto sticky top-0">{renderHeader(item.group)}</div>
                </div>
              </div>
            )
          }}
        </Virtualizer>
      </GroupLayoutContext>
    </div>
  )
}
