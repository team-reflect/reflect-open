import type { ReactElement, ReactNode } from 'react'

interface MobileSearchHeaderProps {
  search: ReactElement
  children: ReactNode
}

/** Keeps mobile search geometry stable, with tab-specific controls in a separate row. */
export function MobileSearchHeader({ search, children }: MobileSearchHeaderProps): ReactElement {
  return (
    <header className="shrink-0 border-b border-border px-4">
      <div className="flex h-11 items-center">{search}</div>
      <div className="pb-2">{children}</div>
    </header>
  )
}
