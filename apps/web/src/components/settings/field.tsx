import type { ReactElement, ReactNode } from 'react'

interface SettingsFieldProps {
  /** The control's name, rendered as the fieldset legend. */
  legend: string
  /** One-line explanation under the legend. */
  description: string
  /** The control itself (option cards, inputs). */
  children: ReactNode
}

/**
 * One labeled control inside a {@link SettingsSection} card: a fieldset whose
 * legend and help text share the settings page's type treatment. Every section
 * renders its controls through this so the row rhythm stays uniform — see
 * docs/contributing/adding-a-setting.md.
 */
export function SettingsField({ legend, description, children }: SettingsFieldProps): ReactElement {
  return (
    <fieldset className="px-4 py-3.5">
      <legend className="float-left text-sm font-medium text-text">{legend}</legend>
      <p className="clear-left mt-0.5 text-xs text-text-muted">{description}</p>
      {children}
    </fieldset>
  )
}
