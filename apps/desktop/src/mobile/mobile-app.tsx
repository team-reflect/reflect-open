import { useEffect, type ReactElement } from 'react'
import { MobileAudioMemoProvider } from '@/mobile/audio-memo-provider.tsx'
import { AppErrorBoundary } from '@/components/app-error-boundary.tsx'
import { MobileOnboardingScreen } from '@/mobile/onboarding-screen.tsx'
import { PaywallDrawer } from '@/mobile/paywall-drawer.tsx'
import { useMobileServices } from '@/mobile/mobile-services.ts'
import { MobileShell } from '@/mobile/mobile-shell.tsx'
import { MobileStatusLayer } from '@/mobile/status-layer.tsx'
import { RecordingDrawer } from '@/mobile/recording-drawer.tsx'
import { WhatsNewDrawer } from '@/mobile/whats-new-drawer.tsx'
import {
  useKeyboardCaretReveal,
  useKeyboardFieldReveal,
  useKeyboardHeightVar,
} from '@/mobile/use-keyboard.ts'
import { usePaywallGate } from '@/mobile/use-paywall-gate.ts'
import { useTaskCheckboxHaptics } from '@/mobile/use-task-haptics.ts'
import { useGraphError, useGraphInfo, useGraphStatus } from '@/providers/graph-provider.tsx'
import { useNeedsOnboarding } from '@/providers/use-mobile-graph-boot.ts'
import { RouterProvider } from '@/routing/router.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Mobile root component (Plan 19): the graph provider bootstraps the fixed
 * `Documents/` root automatically, so there is no chooser — just a loading
 * gate into the route switch. `choosing` only happens when that open failed
 * (the provider parks there with its error), so it renders as an error state.
 *
 * The router mounts per graph exactly as on desktop; `MobileScreen` renders
 * the current route (daily spine, note pages), so wiki-link and date-link
 * taps navigate for real. The keyboard effects and the checkbox-haptic
 * listener mount here so they cover every screen's inputs, and the paywall
 * drawer mounts beside the surface so it can cover any of them.
 */
export function MobileApp(): ReactElement {
  return (
    <>
      <KeyboardEffects />
      <MobileSurface />
      <MobileOverlay />
    </>
  )
}

/**
 * The keyboard-height mirror (so every screen inherits `--keyboard-height`)
 * and the field/caret reveals. A leaf, so a keyboard height change re-renders
 * only this component.
 */
function KeyboardEffects(): null {
  useKeyboardHeightVar()
  useKeyboardFieldReveal()
  useKeyboardCaretReveal()
  return null
}

/**
 * The What's New and paywall drawers over every surface. What's New waits
 * while the paywall shows or may show, so the two never open together.
 * Subscription verification runs beside startup, never in its critical path:
 * while StoreKit or settings are unresolved the gate stays hidden and the
 * local app boots normally. A settled
 * negative answer opens the paywall later. A purchase closes it, and so does
 * Later on a skippable paywall. A leaf, so a gate change re-renders only this
 * component.
 */
function MobileOverlay(): ReactElement {
  const { paywall } = useMobileServices()
  const paywallGate = usePaywallGate()
  return (
    <>
      <WhatsNewDrawer />
      <PaywallDrawer gate={paywallGate} onDismiss={paywall.dismissSkippable} />
    </>
  )
}

/**
 * The onboarding, loading, and error gates in front of the routed shell.
 */
function MobileSurface(): ReactElement {
  const { quitPolicy } = useAppServices()
  const status = useGraphStatus()
  const graph = useGraphInfo()
  const error = useGraphError()
  const needsOnboarding = useNeedsOnboarding()
  useTaskCheckboxHaptics()

  // Flush-on-background (Plan 19, decision 6): iOS may suspend or kill the
  // process soon after backgrounding, so every hide lands dirty note buffers
  // and settings, then makes a local backup commit. Installed unconditionally
  // (each flush is a no-op with nothing open) — the mobile leg of desktop's
  // quit-flush.
  useEffect(() => {
    return quitPolicy.installMobileBackgroundPolicy()
  }, [quitPolicy])

  if (status === 'ready' && graph) {
    return (
      <AppErrorBoundary>
        <RouterProvider key={graph.root}>
          {/* Native recording over the shared capture pipeline — the
              mobile leg of desktop's audio memos. Mounted here so the
              queue, the reconciler, and the orphan scan survive tab
              switches. */}
          <MobileAudioMemoProvider graph={graph}>
            <MobileShell />
            <MobileStatusLayer />
            {/* Mounted beside the shell (not inside the daily screen)
                so a live recording's sheet survives tab switches. */}
            <RecordingDrawer />
          </MobileAudioMemoProvider>
        </RouterProvider>
      </AppErrorBoundary>
    )
  }

  // First run: the provider derived the fixed root but deferred opening it
  // until the user chooses how to start (Plan 19, step 6). Checked before the
  // 'choosing' error branch — onboarding parks at 'choosing' deliberately.
  if (needsOnboarding) {
    return <MobileOnboardingScreen />
  }

  if (status === 'choosing') {
    return (
      <div className="flex h-dvh w-screen flex-col items-center justify-center gap-2 px-safe-offset-8 text-center">
        <p className="text-sm font-medium">Couldn’t open your notes</p>
        <p className="text-sm text-text-muted">{error ?? 'Unknown error'}</p>
      </div>
    )
  }

  return <LoadingScreen />
}

function LoadingScreen(): ReactElement {
  return (
    <div className="flex h-dvh w-screen items-center justify-center px-safe text-sm text-text-muted">
      Loading…
    </div>
  )
}
