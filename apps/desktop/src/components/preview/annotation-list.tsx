import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { AnnotationItem } from '@/lib/annotations/annotations-store'
import { cn } from '@/lib/utils'
import { usePdfViewer } from './pdf-viewer-shell'

interface AnnotationListProps {
  annotations: readonly AnnotationItem[]
  selectedId: string | null
  onSelect: (id: string) => void
}

/** How long a row pulses after it is clicked. */
const FLASH_MS = 700

/**
 * The sidebar's annotation index, grouped by page. Clicking a row selects the
 * annotation (the highlight layer draws it emphasized), jumps the viewer to
 * its page, and pulses the row briefly.
 */
export function AnnotationList({
  annotations,
  selectedId,
  onSelect,
}: AnnotationListProps): ReactElement {
  const { viewer } = usePdfViewer()
  // pdf.js is an external object, not React state: the page jump mutates it
  // through a ref (the immutability rule allows refs), mirroring the shell's
  // own viewer mutations.
  const viewerRef = useRef(viewer)
  // eslint-disable-next-line react-hooks/refs
  viewerRef.current = viewer
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimeout = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (flashTimeout.current !== null) {
        window.clearTimeout(flashTimeout.current)
      }
    }
  }, [])

  const handleSelect = (item: AnnotationItem): void => {
    onSelect(item.id)
    if (viewerRef.current !== null) {
      viewerRef.current.currentPageNumber = item.pageIndex + 1
    }
    setFlashId(item.id)
    if (flashTimeout.current !== null) {
      window.clearTimeout(flashTimeout.current)
    }
    flashTimeout.current = window.setTimeout(() => setFlashId(null), FLASH_MS)
  }

  const byPage = new Map<number, readonly AnnotationItem[]>()
  for (const item of annotations) {
    const existing = byPage.get(item.pageIndex)
    byPage.set(item.pageIndex, existing === undefined ? [item] : [...existing, item])
  }
  const pages: Array<[number, readonly AnnotationItem[]]> = []
  for (const [pageIndex, items] of byPage) {
    pages.push([pageIndex, items])
  }
  pages.sort(([a], [b]) => a - b)

  return (
    <div className="min-h-0 shrink-0 max-h-52 overflow-y-auto border-t border-border">
      {pages.length === 0 ? (
        <p className="px-3.5 py-3 text-xs text-text-muted italic">No annotations yet</p>
      ) : (
        <div className="space-y-4 py-2">
          {pages.map(([pageIndex, items]) => (
            <section key={pageIndex} className="space-y-0.5">
              <h3 className="px-3.5 text-2xs font-medium text-text-muted">Page {pageIndex + 1}</h3>
              <ul>
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={cn(
                        'group flex w-full items-center gap-2 rounded-md px-3.5 py-1 text-left text-xs text-text',
                        'hover:bg-surface-hover',
                        selectedId === item.id && 'bg-surface-active',
                        flashId === item.id && 'animate-pulse',
                      )}
                      onClick={() => handleSelect(item)}
                    >
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-[3px] border border-black/10"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {item.text === '' ? (
                          <span className="italic text-text-muted">No text</span>
                        ) : (
                          item.text
                        )}
                      </span>
                      <span className="shrink-0 tabular-nums text-2xs text-text-muted">
                        p{pageIndex + 1}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
