import { type ReactElement } from 'react'
import { type AppPlatform } from '@reflect/core'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MobileApp } from '@/mobile/mobile-app'
import { GraphProvider } from '@/providers/graph-provider'

/**
 * The mobile surface tree (Plan 19): the shared graph provider in its
 * fixed-root bootstrap (no chooser, no recents reopen) under the mobile app
 * shell. Desktop-only providers (auto-update, drag region) never load here.
 */
export function MobileRoot({ platform }: { platform: AppPlatform }): ReactElement {
  return (
    <GraphProvider platform={platform}>
      <TooltipProvider>
        <MobileApp />
      </TooltipProvider>
    </GraphProvider>
  )
}
