import type { ReactElement } from 'react'
import { SettingsNavigator } from '@/components/settings/settings-navigator'
import { SettingsScreen } from '@/components/settings-screen'
import { ScrollRestored } from '@/routing/scroll-restore'

/** The settings column and its section navigator load together on navigation. */
export function SettingsRoute(): ReactElement {
  return (
    <ScrollRestored className="@container h-full overflow-auto px-6 py-8">
      <div className="relative mx-auto w-full max-w-2xl">
        <div className="absolute inset-y-0 right-full hidden w-48 pr-8 @min-[68rem]:block">
          <SettingsNavigator className="sticky top-8" />
        </div>
        <SettingsScreen />
      </div>
    </ScrollRestored>
  )
}
