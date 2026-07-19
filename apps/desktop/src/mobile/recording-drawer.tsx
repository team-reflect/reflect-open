import { useEffect, useRef, useState, type ReactElement } from 'react'
import { AUDIO_MEMO_MAX_DURATION_LABEL } from '@reflect/core'
import { Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { useMobileAudioMemo } from '@/mobile/audio-memo-provider'
import { RecordingLevelWaveform } from '@/mobile/recording-level-waveform'
import { useRouter } from '@/routing/router'

/**
 * The recording sheet (V1's recording modal as a bottom drawer): waveform +
 * elapsed time with a stop control while recording, and the capture-failure
 * state with Retry/Discard. Dragging the sheet down mid-recording
 * stops-and-saves — dismissal must never silently drop audio; discarding is
 * explicit and requires a second tap. The provider owns open state and the
 * stop/discard semantics behind `onDrawerOpenChange`.
 *
 * Without an OpenAI/Gemini model the sheet shows key-setup guidance instead
 * of recording controls: the mic FAB stays discoverable, but recording never
 * starts until transcription has a key to run on.
 */
export function RecordingDrawer(): ReactElement {
  const memo = useMobileAudioMemo()

  return (
    <Drawer open={memo.drawerOpen} onOpenChange={memo.onDrawerOpenChange}>
      <DrawerContent aria-label="Audio memo">
        <DrawerTitle className="sr-only">Audio memo</DrawerTitle>
        {memo.error !== null ? (
          <div className="flex flex-col gap-3 px-2 pb-2">
            <p className="text-sm text-destructive">{memo.error}</p>
            <div className="flex gap-2">
              {memo.canRetry ? (
                <Button variant="secondary" onClick={() => memo.retry()}>
                  Retry
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => memo.discard()}>
                Discard
              </Button>
            </div>
          </div>
        ) : !memo.hasTranscriptionConfig ? (
          <KeySetupControls memo={memo} />
        ) : (
          <LiveRecordingControls key={memo.drawerOpen ? 'open' : 'closed'} memo={memo} />
        )}
      </DrawerContent>
    </Drawer>
  )
}

type MobileAudioMemo = ReturnType<typeof useMobileAudioMemo>

interface LiveRecordingControlsProps {
  memo: MobileAudioMemo
}

function KeySetupControls({ memo }: LiveRecordingControlsProps): ReactElement {
  const { navigate } = useRouter()

  return (
    <div className="flex flex-col items-center gap-4 px-4 pb-2 text-center">
      <p className="text-sm text-text-muted">
        Audio memos are transcribed into your notes with your own OpenAI or Gemini API key. Add
        one in Settings to start recording.
      </p>
      <Button
        onClick={() => {
          memo.onDrawerOpenChange(false)
          navigate({ kind: 'settings' })
        }}
      >
        Open Settings
      </Button>
    </div>
  )
}

function LiveRecordingControls({ memo }: LiveRecordingControlsProps): ReactElement {
  const [discardArmed, setDiscardArmed] = useState(false)
  const discardResetTimer = useRef<number | null>(null)

  const clearDiscardReset = (): void => {
    if (discardResetTimer.current !== null) {
      window.clearTimeout(discardResetTimer.current)
      discardResetTimer.current = null
    }
  }

  useEffect(
    () => () => {
      if (discardResetTimer.current !== null) {
        window.clearTimeout(discardResetTimer.current)
      }
    },
    [],
  )

  const confirmDiscard = (): void => {
    if (!discardArmed) {
      setDiscardArmed(true)
      clearDiscardReset()
      discardResetTimer.current = window.setTimeout(() => {
        setDiscardArmed(false)
        discardResetTimer.current = null
      }, 3000)
      return
    }
    clearDiscardReset()
    memo.cancelRecording()
  }

  return (
    <div className="flex flex-col items-center gap-4 pb-2">
      <div className="flex h-7 items-center justify-center">
        {memo.phase === 'recording' ? (
          <RecordingLevelWaveform level={memo.level} />
        ) : (
          <p className="text-sm text-text-muted">Waiting for the microphone…</p>
        )}
      </div>
      <div className="flex flex-col items-center">
        <span className="text-lg font-medium tabular-nums">{formatElapsed(memo.elapsedMs)}</span>
        <span className="text-xs text-text-muted">Up to {AUDIO_MEMO_MAX_DURATION_LABEL}</span>
      </div>
      <div className="flex w-full flex-col items-center gap-3">
        <Button
          variant="destructive"
          size="icon"
          aria-label="Stop recording"
          className="size-14 rounded-full"
          disabled={memo.phase !== 'recording'}
          onClick={() => memo.stopAndSave()}
        >
          <Square aria-hidden fill="currentColor" className="size-5" />
        </Button>
        <Button
          variant={discardArmed ? 'destructive' : 'ghost'}
          size="sm"
          className={discardArmed ? undefined : 'text-text-muted'}
          aria-label={discardArmed ? 'Confirm discard recording' : 'Discard recording'}
          onClick={confirmDiscard}
        >
          <Trash2 aria-hidden className="size-3.5" />
          {discardArmed ? 'Tap again to discard' : 'Discard'}
        </Button>
      </div>
    </div>
  )
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
