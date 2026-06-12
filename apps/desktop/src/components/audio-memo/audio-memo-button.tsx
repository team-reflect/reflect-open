import type { ReactElement } from 'react'
import { Square } from 'lucide-react'
import { RecordingPopover } from '@/components/audio-memo/recording-popover'
import { MicIcon } from '@/components/icons/mic-icon'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useAudioMemo } from '@/providers/audio-memo-provider'

/**
 * The microphone beside the sidebar search box. Idle it starts a memo;
 * while one is in flight it becomes the red stop control with the recording
 * panel anchored beside it. Disabled (with the reason as a tooltip) when no
 * OpenAI/Gemini model is configured — `aria-disabled` rather than `disabled`
 * so the tooltip still fires.
 */
export function AudioMemoButton(): ReactElement {
  const memo = useAudioMemo()

  if (memo.phase === 'idle' || memo.phase === 'requesting') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
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
            <MicIcon className="size-[18px]" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {memo.unavailableReason ?? 'Record audio memo'}
        </TooltipContent>
      </Tooltip>
    )
  }

  const activeLabel =
    memo.phase === 'recording'
      ? 'Stop recording'
      : memo.phase === 'error'
        ? 'Discard audio memo'
        : 'Transcribing audio memo'

  return (
    <Popover open>
      <PopoverAnchor asChild>
        <Button
          variant="destructive"
          size="icon-sm"
          className="rounded-full"
          aria-label={activeLabel}
          disabled={memo.phase === 'transcribing'}
          onClick={() => {
            if (memo.phase === 'recording') {
              memo.toggle()
            } else if (memo.phase === 'error') {
              memo.discard()
            }
          }}
        >
          {memo.phase === 'error' ? (
            <MicIcon className="size-[18px]" />
          ) : (
            <Square aria-hidden fill="currentColor" className="size-3" />
          )}
        </Button>
      </PopoverAnchor>
      <RecordingPopover />
    </Popover>
  )
}
