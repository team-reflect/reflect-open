import { useCallback, useSyncExternalStore, type ReactElement } from 'react'
import { cn } from '@/lib/utils.ts'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Failed and warning background operations as tappable pills (Plan 19
 * follow-up): the mobile face of the {@link startOperation} store, which
 * desktop mirrors into its toaster. Without this, a failed write — a task
 * toggle refused by the stale-index guard, a busy note — would roll the
 * optimistic UI back with no explanation. The store already lingers failures
 * and expires them; this renders whatever needs attention, and a tap
 * dismisses early. Running operations stay invisible here — the phone
 * surface only speaks up when something went wrong.
 */
export function MobileOperationsPills(): ReactElement | null {
  const { operations } = useAppServices()
  const subscribe = useCallback(
    (listener: () => void) => operations.subscribe(listener),
    [operations],
  )
  const getAll = useCallback(() => operations.getAll(), [operations])
  const all = useSyncExternalStore(subscribe, getAll)
  const attention = all.filter((operation) => operation.status !== 'running')

  if (attention.length === 0) {
    return null
  }

  return (
    <>
      {attention.map((operation) => (
        <button
          key={operation.id}
          type="button"
          role={operation.status === 'failed' ? 'alert' : 'status'}
          onClick={() => operations.dismiss(operation.id)}
          className="pointer-events-auto flex max-w-[85vw] items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium shadow-sm"
        >
          <span
            aria-hidden
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              operation.status === 'failed' ? 'bg-red-500' : 'bg-amber-500',
            )}
          />
          <span className="truncate">
            {operation.label}
            {operation.message !== null ? (
              <span className="font-normal text-text-muted"> — {operation.message}</span>
            ) : null}
          </span>
        </button>
      ))}
    </>
  )
}
