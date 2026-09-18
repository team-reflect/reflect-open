import type { ReactElement } from 'react'
import { cn } from '@/lib/utils'

interface NoteOpenErrorProps {
  path: string
  message: string | null
  className?: string
}

/** A note document that failed its initial load. */
export function NoteOpenError({ path, message, className }: NoteOpenErrorProps): ReactElement {
  return (
    <div role="alert" className={cn('px-1 py-2 text-sm text-red-500', className)}>
      Couldn’t open {path}: {message}
    </div>
  )
}
