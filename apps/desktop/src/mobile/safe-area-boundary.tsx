import { useState, type ReactElement, type ReactNode } from 'react'
import { MenuBoundaryContext } from '@/editor/menu-boundary.ts'

/**
 * Renders an invisible element that covers the screen minus its safe-area
 * insets (status bar, Dynamic Island, home indicator) and provides it as the
 * editor's menu boundary. Positioning also clips to the visual viewport, so
 * menus stay above the software keyboard too.
 */
export function SafeAreaBoundary({ children }: { children: ReactNode }): ReactElement {
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null)
  return (
    <MenuBoundaryContext value={boundary ?? undefined}>
      <div
        ref={setBoundary}
        aria-hidden
        className="pointer-events-none invisible fixed inset-safe"
      />
      {children}
    </MenuBoundaryContext>
  )
}
