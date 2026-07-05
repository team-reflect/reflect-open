import { useContactsAuthorization } from '@/hooks/use-contacts-authorization'
import { isMacosDesktop } from '@/lib/platform'
import { SETTINGS_SECTIONS } from './sections'

/** One registered settings section (see {@link SETTINGS_SECTIONS}). */
export type SettingsSectionEntry = (typeof SETTINGS_SECTIONS)[number]

/**
 * The settings sections this platform actually shows. Integrations
 * only exists where the OS frameworks do (macOS/iOS — the Rust shell answers
 * `unavailable` elsewhere), and the navigator must agree with the page, so
 * both filter through here rather than reading the registry directly.
 */
export function useVisibleSettingsSections(): readonly SettingsSectionEntry[] {
  const authorization = useContactsAuthorization()
  const hasAppleIntegrations =
    isMacosDesktop || (authorization !== null && authorization !== 'unavailable')
  return SETTINGS_SECTIONS.filter((section) => {
    if (section.id === 'integrations') {
      return hasAppleIntegrations
    }
    if (section.id === 'icloud' || section.id === 'agents') {
      return isMacosDesktop
    }
    return true
  })
}
