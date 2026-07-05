import type { ReactElement, ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface MobileScreenHeaderProps {
  title: string
  /** Pop the screen (the router's back, with a today fallback on cold entry). */
  onBack: () => void
  /** Optional trailing control (an add button, …). */
  trailing?: ReactNode
}

/**
 * The pushed-screen header bar: back chevron, title, optional trailing
 * control — the same chrome as the note screen, shared by the settings
 * screens so every card in the stack navigates the same way.
 */
export function MobileScreenHeader({ title, onBack, trailing }: MobileScreenHeaderProps): ReactElement {
  return (
    <header className="grid h-11 shrink-0 grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center border-b border-border px-1">
      <Button
        variant="ghost"
        size="icon"
        className="size-10 justify-self-center"
        aria-label="Back"
        onClick={onBack}
      >
        <ChevronLeft />
      </Button>
      <h1 className="min-w-0 truncate text-center text-base font-semibold">{title}</h1>
      <div className="flex size-10 items-center justify-center justify-self-center">{trailing}</div>
    </header>
  )
}
