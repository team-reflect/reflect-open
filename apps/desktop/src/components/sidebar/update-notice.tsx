import type { ReactElement } from 'react'
import { ArrowDownToLine, RotateCw } from 'lucide-react'
import { useUpdate } from '@/providers/update-provider'

/**
 * The quiet update affordance above the graph footer: invisible until an
 * update exists, then a single row whose label is always the next action —
 * "Install update" → "Downloading…" → "Restart to update". Ignoring it is
 * deferring it; the row never demands anything.
 */
export function UpdateNotice(): ReactElement | null {
  const { state, install, restart } = useUpdate()

  if (
    state.phase !== 'available' &&
    state.phase !== 'downloading' &&
    state.phase !== 'ready' &&
    state.phase !== 'error'
  ) {
    return null
  }

  if (state.phase === 'downloading') {
    return (
      <div role="status" className="mx-4 px-2.5 py-1.5 text-xs font-medium text-text-muted">
        Downloading update{state.percent !== null ? ` — ${state.percent}%` : '…'}
      </div>
    )
  }

  const { label, icon, action } =
    state.phase === 'ready'
      ? {
          label: 'Restart to update',
          icon: <RotateCw aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />,
          action: restart,
        }
      : {
          label: state.phase === 'error' ? 'Update failed — try again' : 'Install update',
          icon: <ArrowDownToLine aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />,
          action: install,
        }

  return (
    <div className="mx-4">
      <button
        type="button"
        onClick={() => void action()}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-accent transition-colors duration-100 hover:bg-surface-hover"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </button>
    </div>
  )
}
