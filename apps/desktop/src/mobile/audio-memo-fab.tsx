import type { ReactElement } from 'react'
import { Square } from 'lucide-react'
import { MicIcon } from '@/components/icons/mic-icon'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useMobileAudioMemo } from '@/mobile/audio-memo-provider'

/**
 * The daily spine's record button, floating above the new-note FAB (V1
 * parity: voice capture is a first-class affordance, not a settings-adjacent
 * feature). Idle starts a memo, recording reads as the stop control, a
 * spinner carries the transcribe/save progress, and a failure turns it red —
 * tapping reopens the drawer with Retry/Discard. Hidden entirely when the
 * feature can't run (no native bridge). A missing OpenAI/Gemini model never
 * hides it: the feature must stay discoverable, so the tap opens the
 * drawer's key-setup guidance instead of recording.
 */
export function AudioMemoFab(): ReactElement | null {
  const memo = useMobileAudioMemo()

  if (!memo.available) {
    return null
  }

  const recording = memo.phase === 'recording' || memo.phase === 'requesting'
  const label =
    memo.phase === 'error'
      ? 'Show audio memo error'
      : recording
        ? 'Stop recording'
        : 'Record audio memo'

  return (
    <Button
      size="icon"
      variant={recording || memo.phase === 'error' ? 'destructive' : 'secondary'}
      aria-label={label}
      className="fixed right-4 z-40 size-12 rounded-full shadow-lg"
      style={{
        bottom:
          'calc(max(env(safe-area-inset-bottom), var(--keyboard-height, 0px)) + 4.25rem + 3.75rem)',
      }}
      onClick={() => memo.toggle()}
    >
      {memo.phase === 'transcribing' ? (
        <Spinner className="size-5" />
      ) : recording ? (
        <Square aria-hidden fill="currentColor" className="size-4" />
      ) : (
        <MicIcon className="size-6" />
      )}
    </Button>
  )
}
