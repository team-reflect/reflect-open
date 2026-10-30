import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { WorkspaceContent } from '@/components/workspace-content.tsx'
import { WorkspaceProviders } from '@/components/workspace-providers.tsx'
import { SafeAreaBoundary } from '@/mobile/safe-area-boundary.tsx'
import { SidebarWidthEffect } from '@/providers/sidebar-width.tsx'
import { UpdateProvider } from '@/providers/update-provider.tsx'

interface TabletWorkspaceProps {
  graph: GraphInfo
}

/**
 * The desktop workspace in a regular-width iPad window: the sidebars, the
 * ⌘K palette, settings and every shortcut, under the iOS app's own services
 * (onboarding, the paywall, native recording, background flushes), which
 * {@link MobileApp} keeps mounted around it. Like the desktop app it has no
 * formatting toolbar; the phone shell keeps that.
 *
 * The frame ends at the software keyboard's top edge, like the phone shell:
 * the webview is pinned (Plan 19, decision 8), so the page itself must make
 * room. The workspace's columns clear the safe-area insets themselves, so
 * each column's own background runs under the status bar or the window
 * controls instead of a band across the window; the bottom inset sits under
 * the keyboard while it is up. Updates come from the App Store, so the update
 * provider is only there for the settings page to read (`supported` is false
 * on iOS).
 */
export function TabletWorkspace({ graph }: TabletWorkspaceProps): ReactElement {
  return (
    <UpdateProvider>
      <SidebarWidthEffect />
      <SafeAreaBoundary>
        <div className="h-dvh w-screen bg-surface-app pb-(--keyboard-height,0px) px-safe app-shell-safe-insets [--app-shell-height:100%] [--app-shell-width:100%]">
          <WorkspaceProviders graph={graph}>
            <WorkspaceContent graph={graph} />
          </WorkspaceProviders>
        </div>
      </SafeAreaBoundary>
    </UpdateProvider>
  )
}
