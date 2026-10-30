import { useState, type ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { MobileShell } from '@/mobile/mobile-shell.tsx'
import { TabletWorkspace } from '@/mobile/tablet-workspace.tsx'
import { useHorizontalSizeClass } from '@/mobile/use-size-class.ts'
import { useAppServices } from '@/services/services-provider.tsx'

interface TabletShellProps {
  graph: GraphInfo
}

/**
 * The iPad's surface, chosen by the window's horizontal size class the way
 * iPadOS apps lay out: the desktop workspace while the window is regular, the
 * phone shell while it is compact (Slide Over, a narrow Split View pane, a
 * small Stage Manager window). Both sit under the one router {@link MobileApp}
 * mounts per graph, so crossing between them keeps the current note and its
 * history; leaving a surface unmounts its editors, which flush as they go.
 * Until the window first reports its size class nothing renders, rather than
 * a guess that would remount a moment later.
 */
export function TabletShell({ graph }: TabletShellProps): ReactElement {
  const { navigation } = useAppServices()
  const sizeClass = useHorizontalSizeClass()
  // The other surface's scroll offsets mean nothing to the next one (a phone
  // carousel page is no daily-stream position), so each surface anchors
  // afresh. Dropped while rendering, the way state adjusts during render, so
  // the incoming views never read a stale offset.
  const [shownSizeClass, setShownSizeClass] = useState(sizeClass)
  if (sizeClass !== shownSizeClass) {
    setShownSizeClass(sizeClass)
    navigation.forgetScrollStates()
  }
  if (sizeClass === null) {
    return <div aria-busy className="h-dvh w-screen bg-surface" />
  }
  return sizeClass === 'regular' ? <TabletWorkspace graph={graph} /> : <MobileShell />
}
