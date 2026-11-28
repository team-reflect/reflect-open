import {
  createContext,
  use,
  useCallback,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
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
import { cn } from '@/lib/utils.ts'
import { useRouterHandlers, useRouterState } from '@/routing/router.tsx'

/**
 * Height (px) of a group header.
 */
const HEADER_HEIGHT = 36

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
   * Classes for the scroll container: its size and inline padding. The list
   * starts at the top of the container.
   */
  className?: string | undefined
  /**
   * Called when the list scrolls.
   */
  onScroll?: (() => void) | undefined
  onContextMenu?: MouseEventHandler<HTMLDivElement> | undefined
  groups: readonly TaskGroup[]
  /**
   * Whether `groups` holds every task to show. The saved scroll position is
   * restored once it does.
   */
  ready: boolean
  /**
   * Size hint (px) for items not measured yet: a single-line task row.
   */
  rowHeight: number
  /**
   * Space (px) under the last row of each group.
   */
  groupGap?: number | undefined
  /**
   * A task whose row stays mounted out of view, and shows before the list
   * measures it, so an editor in it can take the focus.
   */
  keepMountedTaskId?: string | null | undefined
  /**
   * Renders a group header. It fills the header slot. Keep the function
   * stable: the list renders every header again when it changes.
   */
  renderHeader: (group: TaskGroup) => ReactElement
  /**
   * Renders a row. Keep the function stable: the list renders every row
   * again when it changes.
   */
  renderRow: (row: TaskListRow) => ReactElement
}

const ItemsContext = createContext<readonly TaskListItem[]>([])

function TaskListItemElement({
  style,
  index,
  children,
  ref,
}: CustomItemComponentProps): ReactElement {
  const isHeader = use(ItemsContext)[index]?.kind === 'header'
  // The item is a stacking context, so the z-index of its header goes on the item.
  const itemStyle = useMemo(() => (isHeader ? { ...style, zIndex: 1 } : style), [style, isHeader])
  return (
    <li ref={ref} style={itemStyle}>
      {children}
    </li>
  )
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
 * Tracks the groups near the viewport and how tall each is. The caller runs
 * `update` when the list scrolls or an item changes size.
 */
function useGroupTracks(
  virtualizerRef: RefObject<VirtualizerHandle | null>,
  headerIndexes: readonly number[],
  groupGap: number,
): GroupTracks {
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

  useLayoutEffect(update, [update])

  return { heights, update }
}

/**
 * Keeps the scroll position of the list per history entry: the item at the
 * top and the pixels into it. Returns the function that saves an offset.
 */
function useScrollMemory(
  virtualizerRef: RefObject<VirtualizerHandle | null>,
  items: readonly TaskListItem[],
  ready: boolean,
): (offset: number) => void {
  const { arrivalSeq, entryId } = useRouterState()
  const { saveScrollState, savedScroll } = useRouterHandlers()

  const restore = useEffectEvent(() => {
    const virtualizer = virtualizerRef.current
    if (virtualizer === null) {
      return
    }
    const saved = savedScroll()
    const position = typeof saved === 'object' ? saved : null
    if (position === null) {
      // A scroll job of virtua outlives the call, so none starts at the top.
      if (virtualizer.scrollOffset !== 0) {
        virtualizer.scrollTo(0)
      }
      return
    }
    const index = items.findIndex((item) => item.key === position.key)
    if (index !== -1) {
      virtualizer.scrollToIndex(index, { align: 'start', offset: position.offset })
    }
  })

  // An arrival restores its saved position once, and a new one starts at the
  // top. A saved item that is gone leaves the list where it is.
  const restoredArrivalRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const arrival = `${entryId}:${arrivalSeq}`
    if (ready && restoredArrivalRef.current !== arrival) {
      restoredArrivalRef.current = arrival
      restore()
    }
  }, [arrivalSeq, entryId, ready])

  return useCallback(
    (offset: number) => {
      const virtualizer = virtualizerRef.current
      if (virtualizer === null) {
        return
      }
      const index = virtualizer.findItemIndex(offset)
      const item = items[index]
      if (item !== undefined) {
        saveScrollState({ key: item.key, offset: offset - virtualizer.getItemOffset(index) })
      }
    },
    [virtualizerRef, items, saveScrollState],
  )
}

/**
 * The virtualized list of task groups, in its own scroll container. A group
 * header sticks to the top while its group is in view: the header item holds
 * a track as tall as the group, and the header is sticky inside the track.
 */
export function TaskList({
  ref,
  className,
  onScroll: onScrollProp,
  onContextMenu,
  groups,
  ready,
  rowHeight,
  groupGap = 0,
  keepMountedTaskId,
  renderHeader,
  renderRow,
}: TaskListProps): ReactElement {
  const virtualizerRef = useRef<VirtualizerHandle>(null)

  const { items, headerIndexes, indexByTaskId } = useMemo(() => flattenTaskGroups(groups), [groups])
  // One element per item, so an item renders again only when the data or its
  // renderer changes, not when the list scrolls.
  const elements = useMemo(() => {
    return items.map((item) => {
      return item.kind === 'header' ? renderHeader(item.group) : renderRow(item)
    })
  }, [items, renderHeader, renderRow])
  const { heights: trackHeights, update: updateTracks } = useGroupTracks(
    virtualizerRef,
    headerIndexes,
    groupGap,
  )
  const saveScroll = useScrollMemory(virtualizerRef, items, ready)

  const keepMountedIndex =
    keepMountedTaskId == null ? undefined : indexByTaskId.get(keepMountedTaskId)
  const keepMounted = useMemo(() => {
    const indexes = [...trackHeights.keys()]
    return keepMountedIndex === undefined ? indexes : [...indexes, keepMountedIndex]
  }, [trackHeights, keepMountedIndex])

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

  const onScroll = useCallback(
    (offset: number) => {
      updateTracks()
      saveScroll(offset)
      onScrollProp?.()
    },
    [updateTracks, saveScroll, onScrollProp],
  )

  return (
    <div className={cn('overflow-y-auto', className)} onContextMenu={onContextMenu}>
      <ItemsContext value={items}>
        <Virtualizer
          ref={virtualizerRef}
          as="ul"
          item={TaskListItemElement}
          data={items}
          itemSize={rowHeight}
          bufferSize={ROW_BUFFER}
          keepMounted={keepMounted}
          onScroll={onScroll}
          onResize={updateTracks}
        >
          {(item, index) => {
            if (item.kind !== 'header') {
              // The gap is padding inside the item, so the item's measured size includes it.
              const next = items[index + 1]
              const isGroupEnd = next === undefined || next.kind === 'header'
              // virtua hides an item until it is measured, and a hidden editor cannot take the focus.
              const visibility = index === keepMountedIndex ? 'visible' : undefined
              return (
                <div
                  key={item.key}
                  style={{ paddingBottom: isGroupEnd ? groupGap : 0, visibility }}
                >
                  {elements[index]}
                </div>
              )
            }
            return (
              <div key={item.key} style={{ height: HEADER_HEIGHT }}>
                <div
                  className="pointer-events-none absolute inset-x-0 top-0"
                  style={{ height: trackHeights.get(index) }}
                >
                  <div
                    className="pointer-events-auto sticky top-0"
                    style={{ height: HEADER_HEIGHT }}
                  >
                    {elements[index]}
                  </div>
                </div>
              </div>
            )
          }}
        </Virtualizer>
      </ItemsContext>
      {/* Space under the list, clear of the mobile chrome. It is not padding on
          the container: virtua sizes its viewport by the content box. */}
      <div aria-hidden className="pb-chrome-safe-offset-8" />
    </div>
  )
}
