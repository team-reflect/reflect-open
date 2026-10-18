import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { Virtualizer } from 'virtua'
import { Badge } from '@/components/ui/badge.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import {
  entryKey,
  loadLicenses,
  type LicenseEntry,
  type Licenses,
} from '@/lib/licenses/licenses.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { cn } from '@/lib/utils.ts'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Every bundled third-party component with its license. The parent must give
 * this element a bounded height.
 */
export function LicenseList({ className }: { className?: string | undefined }): ReactElement {
  const { data: licenses } = useQuery({
    queryKey: queryKeys.licenses,
    queryFn: loadLicenses,
    staleTime: Infinity,
  })
  if (licenses === undefined) {
    return (
      <div className={cn('flex items-center justify-center', className)}>
        <Spinner />
      </div>
    )
  }
  return <LicenseEntries licenses={licenses} className={className} />
}

/**
 * One row per component, in file order. A row expands in place to show the
 * license text. The list is virtualized and only expanded rows render their
 * text, because the full set of texts is over a megabyte.
 */
export function LicenseEntries({
  licenses,
  className,
}: {
  licenses: Licenses
  className?: string | undefined
}): ReactElement {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

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
    <div className={cn('min-h-0 overflow-y-auto', className)}>
      <Virtualizer as="ul" item="li" data={licenses.entries}>
        {(entry) => {
          const key = entryKey(entry)
          const expanded = open.has(key)
          return (
            <div key={key} className="border-b border-border">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => toggle(key)}
                className="flex min-h-10 w-full items-center gap-3 py-2 text-left text-sm"
              >
                <ChevronRight
                  aria-hidden
                  className={cn(
                    'size-4 shrink-0 text-text-muted transition-transform',
                    expanded && 'rotate-90',
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-text">{entry.name}</span>
                <span className="shrink-0 text-xs text-text-muted tabular-nums">
                  {entry.version}
                </span>
                <Badge variant="secondary" className="font-mono text-[11px]">
                  {entry.license}
                </Badge>
              </button>
              {expanded ? <LicenseDetail entry={entry} licenses={licenses} /> : null}
            </div>
          )
        }}
      </Virtualizer>
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
    <div className="flex min-w-0 flex-col gap-3 pb-4 pl-7">
      {url !== undefined ? (
        <button
          type="button"
          onClick={() => opener.openUrlSync(url)}
          className="inline-flex w-fit items-center gap-1 text-xs text-text-secondary hover:text-text"
        >
          Homepage
          <ExternalLink aria-hidden className="size-3" />
        </button>
      ) : null}
      {entry.texts.length === 0 ? (
        <p className="text-xs text-text-muted">
          This package ships no license file. It is licensed under {entry.license}.
        </p>
      ) : (
        entry.texts.map((index) => (
          <pre
            key={index}
            className="rounded-lg bg-muted p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-text-secondary select-text"
          >
            {licenses.texts[index]}
          </pre>
        ))
      )}
    </div>
  )
}
