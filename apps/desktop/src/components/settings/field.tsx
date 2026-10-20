import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils.ts'

interface SettingsFieldProps {
  /** The control's name, rendered as the fieldset legend. */
  legend: string
  /** One-line explanation under the legend. */
  description: string
  /**
   * `row` (the default) is one hairline-separated row of a section card;
   * `card` is a bordered box of its own, for fields laid out side by side.
   */
  variant?: 'row' | 'card'
  /** The control itself (option cards, inputs). */
  children: ReactNode
}

/**
 * One labeled control inside a {@link SettingsSection} card: a fieldset whose
 * legend and help text share the settings page's type treatment. Every section
 * renders its controls through this so the row rhythm stays uniform — see
 * docs/contributing/adding-a-setting.md.
 */
export function SettingsField({
  legend,
  description,
  variant = 'row',
  children,
}: SettingsFieldProps): ReactElement {
  return (
    <fieldset
      className={cn('px-4 py-3.5', variant === 'card' && 'rounded-md border border-border')}
    >
      <legend className="float-left text-sm font-medium text-text">{legend}</legend>
      <p className="clear-left mt-0.5 text-xs text-text-muted">{description}</p>
      {children}
    </fieldset>
  )
}
