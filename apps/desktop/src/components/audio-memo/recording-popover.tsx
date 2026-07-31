import type { ComponentProps, ReactElement } from 'react'
import { RecordingWaveform } from '@/components/audio-memo/recording-waveform'
import { Button } from '@/components/ui/button'
import { PopoverContent } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { audioMemoCapWarning, formatRecordingElapsed } from '@/lib/recording-time'
import { useAudioMemo } from '@/providers/audio-memo-provider'

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
  const memo = useAudioMemo()
  const capWarning = memo.phase === 'recording' ? audioMemoCapWarning(memo.elapsedMs) : null

  return (
    <PopoverContent
      side="right"
      align="center"
      sideOffset={10}
      anchor={anchor}
      className="w-auto px-3 py-2"
      initialFocus={false}
    >
      {memo.phase === 'error' ? (
        <div className="flex max-w-72 flex-col gap-2">
          <p className="text-xs text-destructive">{memo.error}</p>
          <div className="flex gap-1.5">
            {memo.canRetry ? (
              <Button size="xs" variant="secondary" onClick={() => memo.retry()}>
                Retry
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={() => memo.discard()}>
              Discard
            </Button>
          </div>
        </div>
      ) : memo.phase === 'transcribing' ? (
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Spinner />
          Transcribing…
        </div>
      ) : (
        <div className="flex items-center gap-3">
          {memo.stream ? <RecordingWaveform stream={memo.stream} /> : null}
          <span className="text-sm font-medium tabular-nums">
            {formatRecordingElapsed(memo.elapsedMs)}
          </span>
          {capWarning === null ? null : (
            <span className="text-xs text-text-muted">{capWarning}</span>
          )}
        </div>
      )}
    </PopoverContent>
  )
}
