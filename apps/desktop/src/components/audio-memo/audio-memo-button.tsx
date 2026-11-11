import { useRef, type ComponentProps, type ReactElement } from 'react'
import { Square } from 'lucide-react'
import { RecordingPopover } from '@/components/audio-memo/recording-popover.tsx'
import { MicIcon } from '@/components/icons/mic-icon.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Popover } from '@/components/ui/popover.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'
import {
  useAudioMemo,
  useAudioMemoAvailable,
  useAudioMemoPhase,
  useAudioMemoUnavailableReason,
} from '@/providers/audio-memo-provider.tsx'

/**
 * The microphone beside the sidebar search box. Idle it starts a memo;
 * recording it becomes the red stop control with the recording panel anchored
 * beside it. While earlier memos are still transcribing the mic stays live —
 * memos queue, so the next recording can start immediately. Disabled (with
 * the reason as a tooltip) when no OpenAI/Gemini model is configured —
 * `aria-disabled` rather than `disabled` so the tooltip still fires. Under the
 * iOS app, its recording sheet presents the recording instead of the panel.
 */
export function AudioMemoButton(): ReactElement {
  const { toggle, cancel, discard, presentation } = useAudioMemo()
  const phase = useAudioMemoPhase()
  const available = useAudioMemoAvailable()
  const unavailableReason = useAudioMemoUnavailableReason()
  const anchorRef = useRef<HTMLButtonElement>(null)

  // Esc cancels a live recording and dismisses an error. Other close
  // requests (outside clicks) stay inert: `open` is controlled and the
  // recording owns its lifecycle.
  const onOpenChange: ComponentProps<typeof Popover>['onOpenChange'] = (nextOpen, eventDetails) => {
    if (!nextOpen && eventDetails.reason === 'escape-key') {
      if (phase === 'recording') {
        cancel()
      } else if (phase === 'error') {
        discard()
      }
    }
  }

  // The iOS recording sheet presents everything but the start and stop taps,
  // and a recording never stands in the way of queueing the next one.
  const sheetPresented = presentation === 'sheet'

  // Like the phone's capture menu, a pending permission prompt stops (cancels)
  // from the same control as a live recording.
  if (sheetPresented && (phase === 'recording' || phase === 'requesting')) {
    return (
      <Button
        variant="destructive"
        size="icon-sm"
        className="rounded-full"
        aria-label="Stop recording"
        onClick={() => toggle()}
      >
        <Square aria-hidden fill="currentColor" className="size-3" />
      </Button>
    )
  }

  if (phase === 'idle' || phase === 'requesting' || sheetPresented) {
    // A parked error makes the mic reopen the iOS sheet with Retry and Discard
    // instead of recording, so it says so, like the phone's capture menu.
    const label =
      sheetPresented && phase === 'error' ? 'Show audio memo error' : 'Record audio memo'
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              aria-disabled={!available || undefined}
              onClick={() => {
                if (available) {
                  toggle()
                }
              }}
              className={cn(
                'text-text-muted hover:text-text-secondary dark:hover:text-text',
                !available && 'opacity-50 hover:bg-transparent hover:text-text-muted',
              )}
            >
              <MicIcon className="size-5" />
            </Button>
          }
        />
        <TooltipContent side="bottom">{unavailableReason ?? label}</TooltipContent>
      </Tooltip>
    )
  }

  if (phase === 'transcribing') {
    return (
      <Popover open onOpenChange={onOpenChange}>
        <Button
          ref={anchorRef}
          variant="ghost"
          size="icon-sm"
          aria-label="Record audio memo"
          onClick={() => toggle()}
          className="text-text-muted hover:text-text-secondary dark:hover:text-text"
        >
          <MicIcon className="size-5" />
        </Button>
        <RecordingPopover anchor={anchorRef} />
      </Popover>
    )
  }

  const activeLabel = phase === 'recording' ? 'Stop recording' : 'Discard audio memo'

  return (
    <Popover open onOpenChange={onOpenChange}>
      <Button
        ref={anchorRef}
        variant="destructive"
        size="icon-sm"
        className="rounded-full"
        aria-label={activeLabel}
        onClick={() => {
          if (phase === 'recording') {
            toggle()
          } else {
            discard()
          }
        }}
      >
        {phase === 'error' ? (
          <MicIcon className="size-5" />
        ) : (
          <Square aria-hidden fill="currentColor" className="size-3" />
        )}
      </Button>
      <RecordingPopover anchor={anchorRef} />
    </Popover>
  )
}
