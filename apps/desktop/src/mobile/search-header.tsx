import type { ReactElement, ReactNode } from 'react'

interface MobileSearchHeaderProps {
  /** The search row: the field plus its leading and trailing controls. */
  children: ReactNode
  /** An optional second row under the field (the All tab's filter badges). */
  below?: ReactNode
}

/**
 * The list tabs' header: a bar-height row holding the search field, over an
 * optional second row. The row matches the pushed screens' bar (`h-11`), and
 * both tabs render through this component, so the field keeps its place when
 * the tab bar switches between them.
 */
export function MobileSearchHeader({ children, below }: MobileSearchHeaderProps): ReactElement {
  return (
    <header className="shrink-0 border-b border-border px-4">
      <div className="flex h-11 items-center gap-1">{children}</div>
      {below ? <div className="pb-2">{below}</div> : null}
    </header>
  )
}
