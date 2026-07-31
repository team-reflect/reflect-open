import type { ReactElement, ReactNode } from 'react'
import { settingsSectionDomId, settingsSectionTitle, type SettingsSectionId } from './sections'

interface SettingsSectionProps {
  /**
   * Which {@link SETTINGS_SECTIONS} entry this card renders. Supplies the
   * heading text and the DOM anchor the sticky navigator jumps to.
   */
  id: SettingsSectionId
  /** The card's rows, separated by hairline dividers. */
  children: ReactNode
}

/**
 * The settings page idiom (the original app's): a small section heading over
 * a bordered card whose rows are separated by hairline dividers. Every card is
 * registered in the sections registry so the navigator can list and target it.
 */
export function SettingsSection({ id, children }: SettingsSectionProps): ReactElement {
  const title = settingsSectionTitle(id)
  return (
    <section id={settingsSectionDomId(id)} aria-label={title} className="mt-8 first:mt-0">
      <h2 className="px-1 text-[13px] font-semibold text-text">{title}</h2>
      <div className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
        {children}
      </div>
    </section>
  )
}
