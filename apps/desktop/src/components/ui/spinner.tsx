import type { ReactElement } from 'react'
import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils.ts'

interface SpinnerProps {
  /** Additional classes, typically a size utility (e.g. `size-4`). Defaults to `size-3`. */
  className?: string
}

/** A spinning loading indicator. Pair with a visible text label and set `aria-hidden` is applied automatically. */
export function Spinner({ className }: SpinnerProps): ReactElement {
  return (
    <LoaderCircle
      aria-hidden
      data-testid="spinner"
      className={cn('size-3 animate-spin', className)}
    />
  )
}
