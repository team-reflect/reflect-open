import { useEffect, type ReactElement } from 'react'
import { AmbiguousNoteChooser } from '@/editor/ambiguous-note-chooser'
import { installBackgroundFlush } from '@/lib/background-flush'
import { MobileAudioMemoProvider } from '@/mobile/audio-memo-provider'
import { MobileErrorBoundary } from '@/mobile/mobile-error-boundary'
import { MobileOnboardingScreen } from '@/mobile/onboarding-screen'
import { MobileShell } from '@/mobile/mobile-shell'
import { MobileStatusLayer } from '@/mobile/status-layer'
import { RecordingDrawer } from '@/mobile/recording-drawer'
import { useICloudRefresh } from '@/mobile/use-icloud-refresh'
import { useKeyboardCaretReveal, useKeyboardHeightVar } from '@/mobile/use-keyboard'
import { useTaskCheckboxHaptics } from '@/mobile/use-task-haptics'
import { AttachmentCatalogProvider } from '@/providers/attachment-catalog-provider'
import { CaptureProvider } from '@/providers/capture-provider'
import { ChatProvider } from '@/providers/chat-provider'
import { useGraph } from '@/providers/graph-provider'
import { SyncProvider } from '@/providers/sync-provider'
import { RouterProvider } from '@/routing/router'

/**
 * Mobile root component (Plan 19): the graph provider bootstraps the fixed
 * `Documents/` root automatically, so there is no chooser — just a loading
 * gate into the route switch. `choosing` only happens when that open failed
 * (the provider parks there with its error), so it renders as an error state.
 *
 * The router mounts per graph exactly as on desktop; `MobileScreen` renders
 * the current route (daily spine, note pages), so wiki-link and date-link
 * taps navigate for real. The keyboard-height bridge lives here so every
 * screen inherits `--keyboard-height`; the caret reveal and the
 * checkbox-haptic listener mount here so they cover every screen's editors.
 */
export function MobileApp(): ReactElement {
  const { status, graph, error, needsOnboarding } = useGraph()
  useKeyboardHeightVar()
  useKeyboardCaretReveal()
  useTaskCheckboxHaptics()
  // iCloud graphs have an out-of-process writer (the OS syncing files in):
  // nudge downloads + re-reconcile on resume. Inert for local/git graphs.
  useICloudRefresh()

  // Flush-on-background (Plan 19, decision 6): iOS may suspend or kill the
  // process soon after backgrounding, so every hide lands dirty note buffers
  // and settings, then makes a local backup commit. Installed unconditionally
  // (each flush is a no-op with nothing open) — the mobile leg of desktop's
  // quit-flush.
  useEffect(() => {
    return installBackgroundFlush()
  }, [])

  if (status === 'ready' && graph) {
    return (
      <MobileErrorBoundary>
        <RouterProvider key={graph.root}>
          <AttachmentCatalogProvider
            key={`${graph.root}:${graph.generation}`}
            generation={graph.generation}
          >
            {/* Same engine, contracts, and triggers as desktop (Plan 12) — the
                controller owns resume/edit/online; mobile adds only the
                plain-language status pill (step 10). */}
            <SyncProvider graph={graph}>
              {/* Link capture (Plan 11, iOS share extension): relay the App
                  Group inbox + drain on launch and on every resume. */}
              <CaptureProvider graph={graph}>
                {/* Same chat session engine as desktop (Plan 23): the
                    conversation and composer draft live here so the Chat tab
                    survives tab switches; semantic search is forced off on
                    this surface inside the provider. */}
                <ChatProvider graph={graph}>
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
                    <AmbiguousNoteChooser />
                  </MobileAudioMemoProvider>
                </ChatProvider>
              </CaptureProvider>
            </SyncProvider>
          </AttachmentCatalogProvider>
        </RouterProvider>
      </MobileErrorBoundary>
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
      <div className="flex h-dvh w-screen flex-col items-center justify-center gap-2 px-8 text-center">
        <p className="text-sm font-medium">Couldn’t open your notes</p>
        <p className="text-sm text-text-muted">{error ?? 'Unknown error'}</p>
      </div>
    )
  }

  return (
    <div className="flex h-dvh w-screen items-center justify-center text-sm text-text-muted">
      Loading…
    </div>
  )
}
