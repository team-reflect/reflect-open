import { useContactsState } from '@/hooks/use-contacts-state.ts'
import { useCoreServices } from '@/services/services-provider.tsx'
import { SETTINGS_SECTIONS } from './sections.ts'

/** One registered settings section (see {@link SETTINGS_SECTIONS}). */
export type SettingsSectionEntry = (typeof SETTINGS_SECTIONS)[number]

/**
 * The settings sections this platform actually shows. Integrations
 * only exists where the OS frameworks do (macOS/iOS — the Rust shell answers
 * `unavailable` elsewhere). Agents is macOS-only. The navigator must agree
 * with the page, so both filter through here rather than reading the registry
 * directly.
 */
export function useVisibleSettingsSections(): readonly SettingsSectionEntry[] {
  const { authorization } = useContactsState()
  const { platform } = useCoreServices()
  const hasAppleIntegrations =
    platform.isMacosDesktop || (authorization !== null && authorization !== 'unavailable')
  return SETTINGS_SECTIONS.filter((section) => {
    if (section.id === 'integrations') {
      return hasAppleIntegrations
    }
    if (section.id === 'agents') {
      return platform.isMacosDesktop
    }
    return true
  })
}
