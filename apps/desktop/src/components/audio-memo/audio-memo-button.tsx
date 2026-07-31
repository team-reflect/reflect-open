import { useRef, type ComponentProps, type ReactElement } from 'react'
import { Square } from 'lucide-react'
import { RecordingPopover } from '@/components/audio-memo/recording-popover'
import { MicIcon } from '@/components/icons/mic-icon'
import { Button } from '@/components/ui/button'
import { Popover } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useAudioMemo } from '@/providers/audio-memo-provider'

/**
 * The microphone beside the sidebar search box. Idle it starts a memo;
 * recording it becomes the red stop control with the recording panel anchored
 * beside it. While earlier memos are still transcribing the mic stays live —
 * memos queue, so the next recording can start immediately. Disabled (with
 * the reason as a tooltip) when no OpenAI/Gemini model is configured —
 * `aria-disabled` rather than `disabled` so the tooltip still fires.
 */
export function AudioMemoButton(): ReactElement {
  const memo = useAudioMemo()
  const anchorRef = useRef<HTMLButtonElement>(null)

  // Esc cancels a live recording and dismisses an error. Other close
  // requests (outside clicks) stay inert: `open` is controlled and the
  // recording owns its lifecycle.
  const onOpenChange: ComponentProps<typeof Popover>['onOpenChange'] = (nextOpen, eventDetails) => {
    if (!nextOpen && eventDetails.reason === 'escape-key') {
      if (memo.phase === 'recording') {
        memo.cancel()
      } else if (memo.phase === 'error') {
        memo.discard()
      }
    }
  }

  if (memo.phase === 'idle' || memo.phase === 'requesting') {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Record audio memo"
              aria-disabled={!memo.available || undefined}
              onClick={() => {
                if (memo.available) {
                  memo.toggle()
                }
              }}
              className={cn(
                'text-text-muted hover:text-text-secondary dark:hover:text-text',
                !memo.available && 'opacity-50 hover:bg-transparent hover:text-text-muted',
              )}
            >
              <MicIcon className="size-5" />
            </Button>
          }
        />
        <TooltipContent side="bottom">
          {memo.unavailableReason ?? 'Record audio memo'}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (memo.phase === 'transcribing') {
    return (
      <Popover open onOpenChange={onOpenChange}>
        <Button
          ref={anchorRef}
          variant="ghost"
          size="icon-sm"
          aria-label="Record audio memo"
          onClick={() => memo.toggle()}
          className="text-text-muted hover:text-text-secondary dark:hover:text-text"
        >
          <MicIcon className="size-5" />
        </Button>
        <RecordingPopover anchor={anchorRef} />
      </Popover>
    )
  }

  const activeLabel = memo.phase === 'recording' ? 'Stop recording' : 'Discard audio memo'

  return (
    <Popover open onOpenChange={onOpenChange}>
      <Button
        ref={anchorRef}
        variant="destructive"
        size="icon-sm"
        className="rounded-full"
        aria-label={activeLabel}
        onClick={() => {
          if (memo.phase === 'recording') {
            memo.toggle()
          } else {
            memo.discard()
          }
        }}
      >
        {memo.phase === 'error' ? (
          <MicIcon className="size-5" />
        ) : (
          <Square aria-hidden fill="currentColor" className="size-3" />
        )}
      </Button>
      <RecordingPopover anchor={anchorRef} />
    </Popover>
  )
}
