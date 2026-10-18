import { Suspense, use, useRef, useState, type ReactElement } from 'react'
import { ArrowUpRight, ChevronRight } from 'lucide-react'
import { Virtualizer } from 'virtua'
import { Spinner } from '@/components/ui/spinner.tsx'
import {
  getEntryKey,
  getLicenses,
  type LicenseEntry,
  type Licenses,
} from '@/lib/licenses/licenses.ts'
import { cn } from '@/lib/utils.ts'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Every bundled third-party component with its license. The parent must give
 * this element a bounded height.
 */
export function LicenseList({ className }: { className?: string | undefined }): ReactElement {
  return (
    <Suspense
      fallback={
        <div className={cn('flex items-center justify-center', className)}>
          <Spinner />
        </div>
      }
    >
      <LoadedLicenseList className={className} />
    </Suspense>
  )
}

function LoadedLicenseList({ className }: { className?: string | undefined }): ReactElement {
  return <LicenseEntries licenses={use(getLicenses())} className={className} />
}

/**
 * One card with a row per component, in file order. A row expands in place to
 * show the license text. The list is virtualized and only expanded rows render
 * their text, because rendering every text puts over a megabyte of text in the
 * DOM.
 */
export function LicenseEntries({
  licenses,
  className,
}: {
  licenses: Licenses
  className?: string | undefined
}): ReactElement {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  function toggle(key: string): void {
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(key)) {
        next.add(key)
      }
      return next
    })
  }

  return (
    <div ref={scrollRef} className={cn('min-h-0 scroll-fade overflow-y-auto', className)}>
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
        {/* The card is the direct parent, so the scroll container is passed explicitly. */}
        <Virtualizer data={licenses.entries} scrollRef={scrollRef} bufferSize={600}>
          {(entry, index) => {
            const key = getEntryKey(entry)
            const expanded = open.has(key)
            return (
              <div key={key} className={cn(index > 0 && 'border-t border-border')}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggle(key)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{entry.name}</span>
                  <span className="shrink-0 text-xs text-text-muted">{entry.license}</span>
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      'size-3.5 shrink-0 text-text-muted transition-transform',
                      expanded && 'rotate-90',
                    )}
                  />
                </button>
                {expanded ? <LicenseDetail entry={entry} licenses={licenses} /> : null}
              </div>
            )
          }}
        </Virtualizer>
      </div>
    </div>
  )
}

function LicenseDetail({
  entry,
  licenses,
}: {
  entry: LicenseEntry
  licenses: Licenses
}): ReactElement {
  const { opener } = useAppServices()
  const { url } = entry
  return (
    <div className="flex flex-col gap-3 border-t border-border bg-muted/40 px-4 py-4">
      {url !== undefined ? (
        <button
          type="button"
          onClick={() => opener.openUrlSync(url)}
          className="inline-flex w-fit items-center gap-0.5 text-xs text-text-muted hover:text-text"
        >
          Homepage
          <ArrowUpRight aria-hidden className="size-3" />
        </button>
      ) : null}
      {entry.texts.length === 0 ? (
        <p className="text-xs text-text-muted">
          No license file is included. Licensed under {entry.license}.
        </p>
      ) : (
        entry.texts.map((key) => (
          <pre
            key={key}
            className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-text-secondary select-text"
          >
            {licenses.texts[key]}
          </pre>
        ))
      )}
    </div>
  )
}
