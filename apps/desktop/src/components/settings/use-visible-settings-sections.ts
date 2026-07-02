import { useContactsAuthorization } from '@/hooks/use-contacts-authorization'
import { SETTINGS_SECTIONS } from './sections'

/** One registered settings section (see {@link SETTINGS_SECTIONS}). */
export type SettingsSectionEntry = (typeof SETTINGS_SECTIONS)[number]

/**
 * The settings sections this platform actually shows. System integrations
 * only exists where the OS frameworks do (macOS/iOS — the Rust shell answers
 * `unavailable` elsewhere), and the navigator must agree with the page, so
 * both filter through here rather than reading the registry directly.
 */
export function useVisibleSettingsSections(): readonly SettingsSectionEntry[] {
  const authorization = useContactsAuthorization()
  const hasAppleIntegrations = authorization !== null && authorization !== 'unavailable'
  return SETTINGS_SECTIONS.filter(
    (section) => section.id !== 'integrations' || hasAppleIntegrations,
  )
}
