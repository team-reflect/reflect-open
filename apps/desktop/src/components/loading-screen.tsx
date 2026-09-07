import type { ReactElement } from 'react'

export function LoadingScreen(): ReactElement {
  return (
    <div
      role="status"
      className="flex h-full items-center justify-center p-6 text-sm text-text-muted"
    >
      Loading…
    </div>
  )
}
