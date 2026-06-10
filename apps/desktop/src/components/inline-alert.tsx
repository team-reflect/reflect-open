import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Visual severity of an {@link InlineAlert}. */
export type InlineAlertTone = 'warning' | 'error'

const TONE_CLASSES: Record<InlineAlertTone, string> = {
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  error: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
}

interface InlineAlertProps {
  tone?: InlineAlertTone
  children: ReactNode
  className?: string
}

/**
 * The in-flow alert banner used across the app (save failures, conflicts, the
 * read-only notice, the cloud-sync warning): one place for the tone palette and
 * the `role="alert"` semantics, so every surface announces consistently to
 * assistive tech.
 */
export function InlineAlert({
  tone = 'warning',
  children,
  className,
}: InlineAlertProps): ReactElement {
  return (
    <div
      role="alert"
      className={cn('rounded-md border px-3 py-2 text-xs', TONE_CLASSES[tone], className)}
    >
      {children}
    </div>
  )
}
