import {
  createContext,
  useCallback,
  use,
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
import { Virtualizer, type CustomItemComponentProps, type VirtualizerHandle } from 'virtua'
import type { TaskListItem } from '@/lib/tasks/task-list-items.ts'

interface TaskListVirtualizerProps {
  ref?: Ref<VirtualizerHandle> | undefined
  items: readonly TaskListItem[]
  /**
   * Indexes of the header items, ascending.
   */
  headerIndexes: readonly number[]
  /**
   * Remounts the list, which drops virtua's index-based size cache and scrolls
   * to the top. Pass the search text and filters.
   */
  resetKey: string
  /**
   * Size hint (px) for rows not measured yet: the single-line task row.
   */
  itemSize: number
  /**
   * Extra space (px) rendered above and below the viewport.
   */
  bufferSize: number
  /**
   * Indexes to keep mounted besides the stuck header, e.g. the row being edited.
   */
  keepMounted?: readonly number[] | undefined
  children: (item: TaskListItem, index: number) => ReactElement
}

/**
 * The last header at or above `topIndex`, or -1 when there is none.
 */
export function findActiveHeader(headerIndexes: readonly number[], topIndex: number): number {
  let low = 0
  let high = headerIndexes.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    const index = headerIndexes[middle]!
    if (index <= topIndex) {
      found = index
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

interface StickyHeaders {
  headers: ReadonlySet<number>
  active: number
}

const StickyHeadersContext = createContext<StickyHeaders>({ headers: new Set(), active: -1 })

// Every header paints over the rows, and the next header over the stuck one.
// WebKit paints a sticky item over a later item at the same `z-index`.
const HEADER_STYLE: CSSProperties = { zIndex: 2 }

const STUCK_HEADER_STYLE: CSSProperties = { zIndex: 1, position: 'sticky', top: 0 }

function TaskListItemShell({
  style,
  index,
  children,
  ref,
}: CustomItemComponentProps): ReactElement {
  const { headers, active } = use(StickyHeadersContext)
  const itemStyle = useMemo(() => {
    if (index === active) {
      return { ...style, ...STUCK_HEADER_STYLE }
    }
    return headers.has(index) ? { ...style, ...HEADER_STYLE } : style
  }, [style, index, active, headers])
  return (
    <li ref={ref} style={itemStyle}>
      {children}
    </li>
  )
}

/**
 * A virtualized Tasks list whose group headers stick to the top. Only the
 * current group's header is sticky: it stays mounted and sits in normal flow
 * at the top of the list, and the next header scrolls over it. Must be the
 * direct child of the scroll container.
 */
export function TaskListVirtualizer({
  ref,
  resetKey,
  ...props
}: TaskListVirtualizerProps): ReactElement {
  const handleRef = useRef<VirtualizerHandle>(null)
  // No dependency list: a reset mounts a new virtua handle.
  useImperativeHandle(ref, () => handleRef.current as VirtualizerHandle)
  // The scroll container outlives a remount, so a new list starts at the top.
  const resetKeyRef = useRef(resetKey)
  useLayoutEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey
      handleRef.current?.scrollTo(0)
    }
  }, [resetKey])
  return <StickyTaskList key={resetKey} handleRef={handleRef} {...props} />
}

function StickyTaskList({
  handleRef,
  items,
  headerIndexes,
  itemSize,
  bufferSize,
  keepMounted,
  children,
}: Omit<TaskListVirtualizerProps, 'ref' | 'resetKey'> & {
  handleRef: RefObject<VirtualizerHandle | null>
}): ReactElement {
  const [activeHeader, setActiveHeader] = useState(() => findActiveHeader(headerIndexes, 0))

  const updateActiveHeader = useCallback(
    (offset: number) => {
      const handle = handleRef.current
      if (handle !== null) {
        setActiveHeader(findActiveHeader(headerIndexes, handle.findItemIndex(offset)))
      }
    },
    [handleRef, headerIndexes],
  )

  // A refresh can move the headers to other indexes, so re-pick the stuck one
  // before paint.
  useLayoutEffect(() => {
    const handle = handleRef.current
    if (handle !== null) {
      updateActiveHeader(handle.scrollOffset)
    }
  }, [handleRef, updateActiveHeader])

  const sticky = useMemo(
    () => ({ headers: new Set(headerIndexes), active: activeHeader }),
    [headerIndexes, activeHeader],
  )
  const mounted = useMemo(
    () => (activeHeader === -1 ? (keepMounted ?? []) : [activeHeader, ...(keepMounted ?? [])]),
    [activeHeader, keepMounted],
  )

  return (
    <StickyHeadersContext value={sticky}>
      <Virtualizer
        ref={handleRef}
        as="ul"
        item={TaskListItemShell}
        data={items}
        itemSize={itemSize}
        bufferSize={bufferSize}
        keepMounted={mounted}
        onScroll={updateActiveHeader}
      >
        {children}
      </Virtualizer>
    </StickyHeadersContext>
  )
}
