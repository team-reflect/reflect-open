import { type ReactElement } from 'react'
import { setLocalWriteEcho, type AppPlatform } from '@reflect/core'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setTouchEditorSurface } from '@/editor/touch-surface'
import { MobileApp } from '@/mobile/mobile-app'
import { GraphProvider } from '@/providers/graph-provider'

// Mobile has no file watcher: local writes echo their own file-change events
// in-process (Plan 19, decision 5) so the index, query invalidation, and the
// sync engine's dirty mark behave exactly as on desktop. Module scope — this
// chunk only loads on mobile, and it must precede the first write.
setLocalWriteEcho(true)

// Editors apply iOS text-input hygiene (pinned spellcheck, explicit input
// traits — Plan 19 decision 7 gate). Module scope for the same reason: it
// must precede the first editor mount.
setTouchEditorSurface(true)

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
