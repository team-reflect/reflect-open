import type { ReactElement, ReactNode } from 'react'

export function MobileSearchHeader({ children }: { children: ReactNode }): ReactElement {
  return <header className="shrink-0 border-b border-border px-4">{children}</header>
}

export function MobileSearchHeaderContent({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex h-12 items-center gap-1">{children}</div>
}
