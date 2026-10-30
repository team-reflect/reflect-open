import { useCallback, useMemo } from 'react'
import { useContactsState } from '@/hooks/use-contacts-state.ts'
import { useCoreServices } from '@/services/services-provider.tsx'
import { SETTINGS_SECTIONS, type SettingsSectionId } from './sections.ts'

/** One registered settings section (see {@link SETTINGS_SECTIONS}). */
export type SettingsSectionEntry = (typeof SETTINGS_SECTIONS)[number]

/**
 * Whether this platform shows a settings section. Integrations only exists
 * where the OS frameworks do (macOS/iOS — the Rust shell answers
 * `unavailable` elsewhere). Agents is macOS-only. The iOS app (the iPad's
 * desktop settings) trades Import and the Danger zone, which assume a graph
 * folder of the user's choosing, for its Graph and Subscription sections. The
 * navigator lists through this rule, the active-section tracker takes its
 * first and last sections from it, and the page gates the platform-specific
 * Graph, Import, Subscription and Danger zone sections with it. Agents and
 * Integrations still hide themselves on the page.
 */
export function useIsSettingsSectionVisible(): (id: SettingsSectionId) => boolean {
  const { authorization } = useContactsState()
  const { platform } = useCoreServices()
  const hasAppleIntegrations =
    platform.isMacosDesktop || (authorization !== null && authorization !== 'unavailable')
  const macos = platform.isMacosDesktop
  const ios = platform.appPlatform === 'ios'
  return useCallback(
    (id: SettingsSectionId): boolean => {
      switch (id) {
        case 'integrations':
          return hasAppleIntegrations
        case 'agents':
          return macos
        case 'graph':
        case 'subscription':
          return ios
        case 'import':
        case 'destructive':
          return !ios
        default:
          return true
      }
    },
    [hasAppleIntegrations, macos, ios],
  )
}

/** The settings sections this platform shows, in registry order. */
export function useVisibleSettingsSections(): readonly SettingsSectionEntry[] {
  const isVisible = useIsSettingsSectionVisible()
  return useMemo(() => SETTINGS_SECTIONS.filter((section) => isVisible(section.id)), [isVisible])
}
