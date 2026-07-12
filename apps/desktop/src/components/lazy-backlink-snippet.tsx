import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'
import type { WikilinkClickHandler } from '@meowdown/core'
import { BacklinkSnippet } from '@/components/backlink-snippet'
import { useNearViewport } from '@/hooks/use-near-viewport'
import type { BacklinkSnippetData } from '@/lib/group-backlinks'

const DEFAULT_ESTIMATED_WIDTH_PX = 320
const ESTIMATED_CHARACTER_WIDTH_PX = 7
const ESTIMATED_LINE_HEIGHT_PX = 20
const MINIMUM_CHARACTERS_PER_LINE = 20
const MAX_MEASURED_HEIGHTS = 1_000

const measuredHeights = new Map<string, number>()
const resizeCallbacks = new Map<Element, () => void>()
let sizeObserver: ResizeObserver | null = null
let sizeObserverConstructor: typeof ResizeObserver | null = null

interface LazyBacklinkSnippetProps {
  snippet: BacklinkSnippetData
  notePath: string
  sourceTitle: string
  position: number
  total: number
  onWikilinkClick: WikilinkClickHandler
  resolveImageUrl: (src: string) => string | undefined
}

interface SnippetLayout {
  readonly cacheKey: string
  readonly lineLengths: readonly number[]
}

interface PlaceholderHeightState {
  readonly cacheKey: string
  readonly height: number
}

function snippetLayout(key: string, markdown: string): SnippetLayout {
  let hash = 2_166_136_261
  let lineLength = 0
  const lineLengths: number[] = []
  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown.charCodeAt(index)
    hash = Math.imul(hash ^ character, 16_777_619)
    if (character === 10) {
      lineLengths.push(lineLength)
      lineLength = 0
    } else {
      lineLength += 1
    }
  }
  lineLengths.push(lineLength)
  return {
    cacheKey: `${key}\u0000${markdown.length}:${hash >>> 0}`,
    lineLengths,
  }
}

function estimatedHeight(layout: SnippetLayout, width: number): number {
  const charactersPerLine = Math.max(
    MINIMUM_CHARACTERS_PER_LINE,
    Math.floor(width / ESTIMATED_CHARACTER_WIDTH_PX),
  )
  const visualLines = layout.lineLengths.reduce(
    (total, length) => total + Math.max(1, Math.ceil(length / charactersPerLine)),
    0,
  )
  return Math.max(ESTIMATED_LINE_HEIGHT_PX, visualLines * ESTIMATED_LINE_HEIGHT_PX)
}

function measuredHeightKey(cacheKey: string, width: number): string {
  return `${cacheKey}\u0000${Math.round(width)}`
}

function cacheHeight(key: string, height: number): void {
  measuredHeights.delete(key)
  measuredHeights.set(key, height)
  if (measuredHeights.size > MAX_MEASURED_HEIGHTS) {
    const oldest = measuredHeights.keys().next()
    if (!oldest.done) {
      measuredHeights.delete(oldest.value)
    }
  }
}

function getSizeObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') {
    return null
  }
  if (sizeObserverConstructor !== ResizeObserver) {
    sizeObserver?.disconnect()
    sizeObserverConstructor = ResizeObserver
    sizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        resizeCallbacks.get(entry.target)?.()
      }
    })
  }
  return sizeObserver
}

function observeSize(element: Element, callback: () => void): () => void {
  callback()
  const observer = getSizeObserver()
  resizeCallbacks.set(element, callback)
  observer?.observe(element)
  return () => {
    resizeCallbacks.delete(element)
    observer?.unobserve(element)
  }
}

/**
 * One backlink reference that reserves an approximate (or previously measured)
 * height before mounting Meowdown. Its placeholder is an explicit reveal
 * button for assistive technology; when a focused button reveals, focus moves
 * to the rendered reference instead of falling back to the document.
 */
export function LazyBacklinkSnippet({
  snippet,
  notePath,
  sourceTitle,
  position,
  total,
  onWikilinkClick,
  resolveImageUrl,
}: LazyBacklinkSnippetProps): ReactElement {
  const canDefer = typeof IntersectionObserver !== 'undefined'
  const [rendered, setRendered] = useState(!canDefer)
  const containerRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef(false)
  const layout = useMemo(() => snippetLayout(snippet.key, snippet.text), [snippet.key, snippet.text])
  const [heightState, setHeightState] = useState<PlaceholderHeightState>(() => ({
    cacheKey: layout.cacheKey,
    height: estimatedHeight(layout, DEFAULT_ESTIMATED_WIDTH_PX),
  }))
  if (heightState.cacheKey !== layout.cacheKey) {
    setHeightState({
      cacheKey: layout.cacheKey,
      height: estimatedHeight(layout, DEFAULT_ESTIMATED_WIDTH_PX),
    })
  }

  const reveal = useCallback(() => {
    restoreFocusRef.current = containerRef.current?.contains(document.activeElement) === true
    setRendered(true)
  }, [])
  const placeholderRef = useNearViewport(canDefer && !rendered, reveal)
  const placeholderStyle = useMemo<CSSProperties>(
    () => ({ height: heightState.height }),
    [heightState.height],
  )

  useLayoutEffect(() => {
    const element = containerRef.current
    if (element === null) {
      return
    }

    if (rendered) {
      if (restoreFocusRef.current) {
        restoreFocusRef.current = false
        element.focus({ preventScroll: true })
      }
      return observeSize(element, () => {
        const bounds = element.getBoundingClientRect()
        if (bounds.width > 0 && bounds.height > 0) {
          cacheHeight(measuredHeightKey(layout.cacheKey, bounds.width), bounds.height)
        }
      })
    }

    return observeSize(element, () => {
      const width = element.getBoundingClientRect().width
      if (width <= 0) {
        return
      }
      const height =
        measuredHeights.get(measuredHeightKey(layout.cacheKey, width)) ??
        estimatedHeight(layout, width)
      setHeightState((current) =>
        current.cacheKey === layout.cacheKey && current.height === height
          ? current
          : { cacheKey: layout.cacheKey, height },
      )
    })
  }, [layout, rendered])

  if (!rendered) {
    return (
      <div ref={containerRef} style={placeholderStyle}>
        <button
          ref={placeholderRef}
          type="button"
          onClick={reveal}
          className="block size-full overflow-hidden text-left text-xs text-text-muted opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
        >
          Show reference {position} of {total} from {sourceTitle}
        </button>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      aria-label={`Reference ${position} of ${total} from ${sourceTitle}`}
    >
      <BacklinkSnippet
        text={snippet.text}
        notePath={notePath}
        tasks={snippet.tasks}
        onWikilinkClick={onWikilinkClick}
        resolveImageUrl={resolveImageUrl}
      />
    </div>
  )
}
