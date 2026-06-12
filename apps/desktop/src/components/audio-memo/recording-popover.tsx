import type { ReactElement } from 'react'
import { Loader2 } from 'lucide-react'
import { RecordingWaveform } from '@/components/audio-memo/recording-waveform'
import { Button } from '@/components/ui/button'
import { PopoverContent } from '@/components/ui/popover'
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
export function RecordingPopover(): ReactElement {
  const memo = useAudioMemo()

  return (
    <PopoverContent
      side="right"
      align="center"
      sideOffset={10}
      className="w-auto px-3 py-2"
      onOpenAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={() => {
        if (memo.phase === 'recording') {
          memo.cancel()
        } else if (memo.phase === 'error') {
          memo.discard()
        }
      }}
      onInteractOutside={(event) => event.preventDefault()}
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
          <Loader2 aria-hidden className="size-4 animate-spin" />
          Transcribing…
        </div>
      ) : (
        <div className="flex items-center gap-3">
          {memo.stream ? <RecordingWaveform stream={memo.stream} /> : null}
          <span className="text-sm font-medium tabular-nums">{formatElapsed(memo.elapsedMs)}</span>
        </div>
      )}
    </PopoverContent>
  )
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
