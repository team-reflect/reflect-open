import type { ReactElement, ReactNode } from 'react'

interface MobileSearchHeaderProps {
  /** The search row: the field plus its leading and trailing controls. */
  children: ReactNode
  /** An optional second row under the field. */
  below?: ReactNode
}

export function MobileSearchHeader({ children, below }: MobileSearchHeaderProps): ReactElement {
  return (
    <header className="shrink-0 border-b border-border px-4">
      <div className="flex h-11 items-center gap-1">{children}</div>
      {below ? <div className="pb-2">{below}</div> : null}
    </header>
  )
}
