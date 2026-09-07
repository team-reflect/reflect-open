import type { ReactElement } from 'react'
import { SettingsNavigator } from '@/components/settings/settings-navigator'
import { SettingsScreen } from '@/components/settings-screen'
import { ScrollRestored } from '@/routing/scroll-restore'

export function SettingsRoute(): ReactElement {
  // The section navigator floats in the left gutter — absolutely
  // positioned off the centered column so the column never shifts — and
  // only renders when the container query says the gutter can fit it:
  // the 42rem column plus a 12rem rail either side, with a little slack.
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
