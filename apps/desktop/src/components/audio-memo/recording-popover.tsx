import type { ComponentProps, ReactElement } from 'react'
import { RecordingWaveform } from '@/components/audio-memo/recording-waveform.tsx'
import { Button } from '@/components/ui/button.tsx'
import { PopoverContent } from '@/components/ui/popover.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { formatElapsed } from '@reflect/utils'
import { useStore } from '@/lib/use-store.ts'
import {
  useAudioMemo,
  useAudioMemoCanRetry,
  useAudioMemoError,
  useAudioMemoPhase,
  useAudioMemoStream,
} from '@/providers/audio-memo-provider.tsx'

/**
 * The floating panel beside the mic while a memo is in flight: waveform +
 * elapsed time during recording, a spinner while transcribing, and the
 * failure state with Retry/Discard. Esc cancels a live recording and
 * dismisses an error, but is deliberately inert while transcribing — the
 * user already committed the memo by stopping, and "cancelling" a save
 * that may have reached the provider would only feign control. The mic
 * beside the panel stays live while transcribing: memos queue, so the next
 * recording can start immediately. Clicks elsewhere don't dismiss; the
 * recording owns its lifecycle.
 */
export function RecordingPopover({
  anchor,
}: {
  anchor?: ComponentProps<typeof PopoverContent>['anchor']
}): ReactElement {
  const { session, retry, discard } = useAudioMemo()
  const phase = useAudioMemoPhase()
  const error = useAudioMemoError()
  const canRetry = useAudioMemoCanRetry()
  const stream = useAudioMemoStream()
  const elapsedMs = useStore(session.elapsedMs)

  return (
    <PopoverContent
      side="right"
      align="center"
      sideOffset={10}
      anchor={anchor}
      className="w-auto px-3 py-2"
      initialFocus={false}
    >
      {phase === 'error' ? (
        <div className="flex max-w-72 flex-col gap-2">
          <p className="text-xs text-destructive">{error}</p>
          <div className="flex gap-1.5">
            {canRetry ? (
              <Button size="xs" variant="secondary" onClick={() => retry()}>
                Retry
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={() => discard()}>
              Discard
            </Button>
          </div>
        </div>
      ) : phase === 'transcribing' ? (
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Spinner />
          Transcribing…
        </div>
      ) : (
        <div className="flex items-center gap-3">
          {stream ? <RecordingWaveform stream={stream} /> : null}
          <span className="text-sm font-medium tabular-nums">{formatElapsed(elapsedMs)}</span>
        </div>
      )}
    </PopoverContent>
  )
}
