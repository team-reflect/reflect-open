import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react'
import { isDeepEqual } from '@ocavue/utils'
import type { TaskGroup } from '@reflect/core'
import { Virtualizer, type CustomItemComponentProps, type VirtualizerHandle } from 'virtua'
import type { TaskListItem } from '@/lib/tasks/task-list-items.ts'

/**
 * Size hint (px) for rows not measured yet: a single-line task row.
 */
const ROW_HEIGHT = 49

/**
 * How far (px) past the viewport a group keeps its header mounted.
 */
const NEAR_BUFFER = 2000

/**
 * The header item of a group near the viewport, and the group's height (px).
 */
interface GroupTrack {
  index: number
  height: number
}

type TaskRowItem = Exclude<TaskListItem, { kind: 'header' }>

interface MobileTaskListProps {
  /**
   * The scroll container. The list is its first content.
   */
  scrollRef: RefObject<HTMLElement | null>
  items: readonly TaskListItem[]
  /**
   * Indexes of the header items, ascending.
   */
  headerIndexes: readonly number[]
  /**
   * Remounts the list at the top when it changes. Pass the search text and filters.
   */
  resetKey: string
  renderHeader: (group: TaskGroup) => ReactElement
  renderRow: (item: TaskRowItem) => ReactElement
}

const HeaderIndexesContext = createContext<ReadonlySet<number>>(new Set())

function TaskListItemShell({
  style,
  index,
  children,
  ref,
}: CustomItemComponentProps): ReactElement {
  const isHeader = use(HeaderIndexesContext).has(index)
  // A header reaches out of its item, over the rows of its group.
  const itemStyle = useMemo(() => (isHeader ? { ...style, zIndex: 1 } : style), [style, isHeader])
  return (
    <li ref={ref} style={itemStyle}>
      {children}
    </li>
  )
}

/**
 * The virtualized Tasks list. A group header sticks to the top while its
 * group is in view: the header item holds a track as tall as the group, and
 * the header is sticky inside the track.
 */
export function MobileTaskList({ resetKey, ...props }: MobileTaskListProps): ReactElement {
  const { scrollRef } = props
  const resetKeyRef = useRef(resetKey)
  // The scroll container outlives a remount, so a new list starts at the top.
  useLayoutEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey
      scrollRef.current?.scrollTo({ top: 0 })
    }
  }, [resetKey, scrollRef])
  return <StickyTaskList key={resetKey} {...props} />
}

function StickyTaskList({
  scrollRef,
  items,
  headerIndexes,
  renderHeader,
  renderRow,
}: Omit<MobileTaskListProps, 'resetKey'>): ReactElement {
  const handleRef = useRef<VirtualizerHandle>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [tracks, setTracks] = useState<GroupTrack[]>([])

  const updateTracks = useCallback(() => {
    const handle = handleRef.current
    if (handle === null) {
      return
    }
    const start = handle.scrollOffset - NEAR_BUFFER
    const end = handle.scrollOffset + handle.viewportSize + NEAR_BUFFER
    const next: GroupTrack[] = []
    for (const [position, index] of headerIndexes.entries()) {
      const top = handle.getItemOffset(index)
      if (top > end) {
        break
      }
      const nextIndex = headerIndexes[position + 1]
      const bottom = nextIndex === undefined ? handle.scrollSize : handle.getItemOffset(nextIndex)
      if (bottom >= start) {
        next.push({ index, height: bottom - top })
      }
    }
    setTracks((current) => (isDeepEqual(current, next) ? current : next))
  }, [headerIndexes])

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

  const headers = useMemo(() => new Set(headerIndexes), [headerIndexes])
  const keepMounted = useMemo(() => tracks.map((track) => track.index), [tracks])

  return (
    <div ref={listRef}>
      <HeaderIndexesContext value={headers}>
        <Virtualizer
          ref={handleRef}
          scrollRef={scrollRef}
          as="ul"
          item={TaskListItemShell}
          data={items}
          itemSize={ROW_HEIGHT}
          bufferSize={640}
          keepMounted={keepMounted}
          onScroll={updateTracks}
        >
          {(item, index) => {
            if (item.kind !== 'header') {
              return renderRow(item)
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
      </HeaderIndexesContext>
    </div>
  )
}
