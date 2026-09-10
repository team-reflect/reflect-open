import type { ReactElement, ReactNode } from 'react'

export function MobileSearchHeader({ children }: { children: ReactNode }): ReactElement {
  return <header className="shrink-0 border-b border-border px-0">{children}</header>
}

export function MobileSearchHeaderContent({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex min-h-12 items-center gap-1 px-4">{children}</div>
}

export function MobileSearchHeaderScrollableContent({
  children,
}: {
  children: ReactNode
}): ReactElement {
  return (
    <div className="w-full overflow-hidden px-0">
      <div className="scroll-fade-x scrollbar-none overflow-x-auto px-4">{children}</div>
    </div>
  )
}
