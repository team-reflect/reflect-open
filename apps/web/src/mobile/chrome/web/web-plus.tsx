import { useState, type ReactElement } from 'react'
import { CircleCheck, Plus, Square } from 'lucide-react'
import { MicIcon } from '@/components/icons/mic-icon.tsx'
import { PencilIcon } from '@/components/icons/pencil-icon.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { cn } from '@/lib/utils.ts'
import type { ChromePlus } from '@/mobile/chrome/screen-chrome.ts'
import { hapticImpactLight } from '@/mobile/haptics.ts'
import { useMobileForm, type MobileForm } from '@/mobile/mobile-form.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'
import { useKeyboardVisible } from '@/mobile/use-keyboard.ts'

const ACTIONS_ID = 'daily-capture-actions'
const ACTION_MOTION =
  'absolute inset-0 origin-center transition-[translate,scale,opacity] will-change-[translate,scale,opacity] motion-reduce:transition-none'
const ACTION_BUTTON_MOTION =
  'transition-[background-color,color,box-shadow,translate,scale] duration-100 ease-out active:translate-y-0 active:scale-[0.94] motion-reduce:transition-none'

/**
 * Where the `+` sits in each form, matching the shell bars of
 * `web-chrome-renderer.tsx`: on the bar's center line, above the rail's
 * capsule, or in the bottom-right corner.
 */
const PLACEMENT: Record<MobileForm, string> = {
  bar: 'right-safe-offset-3 bottom-safe-offset-3 size-14',
  // The rail's capsule is 38 spacing tall (three `size-12` tabs and `p-1`) at
  // `bottom-safe-offset-2`; the `+` sits 3 spacing above it.
  rail: 'right-safe-offset-3 bottom-safe-offset-43 size-12',
  pad: 'right-safe-offset-6 bottom-safe-offset-6 size-14',
}

/**
 * The `+` the page draws. It hides while the keyboard is up.
 */
export function WebPlus({ plus }: { plus: ChromePlus }): ReactElement | null {
  const form = useMobileForm()
  if (useKeyboardVisible()) {
    return null
  }
  return (
    <div className={cn('fixed z-40', PLACEMENT[form])}>
      {plus.kind === 'action' ? (
        <Button
          size="icon"
          aria-label={plus.label}
          className={cn('size-full rounded-full shadow-lg', ACTION_BUTTON_MOTION)}
          onClick={plus.onTap}
        >
          <Plus className="size-6" />
        </Button>
      ) : (
        <CaptureDial plus={plus} />
      )}
    </div>
  )
}

/**
 * Daily's capture speed dial. The `+` expands into new-note, new-task, and
 * audio-memo actions along one anchored vertical path. The action wrappers
 * remain mounted so a rapid second tap reverses from their live on-screen
 * transforms instead of restarting or jumping.
 */
function CaptureDial({ plus }: { plus: Extract<ChromePlus, { kind: 'capture' }> }): ReactElement {
  const { haptics } = useMobileServices()
  const [expanded, setExpanded] = useState(false)
  const { audio } = plus
  const recording = audio === 'recording' || audio === 'requesting'
  const audioLabel =
    audio === 'error' ? 'Show audio memo error' : recording ? 'Stop recording' : 'Record audio memo'

  const run = (action: () => void): void => {
    setExpanded(false)
    action()
  }

  return (
    <>
      <Button
        size="icon"
        aria-label={expanded ? 'Hide capture actions' : 'Show capture actions'}
        aria-controls={ACTIONS_ID}
        aria-expanded={expanded}
        className={cn('relative z-10 size-full rounded-full shadow-lg', ACTION_BUTTON_MOTION)}
        onClick={() => {
          hapticImpactLight(haptics)
          setExpanded((current) => !current)
        }}
      >
        <span
          aria-hidden
          className={cn(
            'flex transition-[rotate] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
            expanded && 'rotate-45',
          )}
        >
          <Plus className="size-6" />
        </span>
      </Button>

      <div id={ACTIONS_ID} role="group" aria-label="Capture actions" aria-hidden={!expanded}>
        <div
          data-slot="new-note-action"
          className={cn(
            ACTION_MOTION,
            expanded
              ? 'pointer-events-auto z-[1] -translate-y-5/4 scale-100 opacity-100 duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
              : 'pointer-events-none z-[1] translate-y-0 scale-50 opacity-0 delay-[50ms] duration-200 ease-[cubic-bezier(0.64,0,0.78,0)]',
          )}
        >
          <Button
            size="icon"
            variant="secondary"
            aria-label="New note"
            tabIndex={expanded ? 0 : -1}
            className={cn('size-full rounded-full shadow-lg', ACTION_BUTTON_MOTION)}
            onClick={() => run(plus.onNote)}
          >
            <PencilIcon className="size-6" />
          </Button>
        </div>

        <div
          data-slot="new-task-action"
          className={cn(
            ACTION_MOTION,
            expanded
              ? 'pointer-events-auto -translate-y-5/2 scale-100 opacity-100 delay-[35ms] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
              : 'pointer-events-none translate-y-0 scale-50 opacity-0 delay-[25ms] duration-200 ease-[cubic-bezier(0.64,0,0.78,0)]',
          )}
        >
          <Button
            size="icon"
            variant="secondary"
            aria-label="New task"
            tabIndex={expanded ? 0 : -1}
            className={cn('size-full rounded-full shadow-lg', ACTION_BUTTON_MOTION)}
            onClick={() => run(plus.onTask)}
          >
            <CircleCheck aria-hidden className="size-5" />
          </Button>
        </div>

        {audio !== null ? (
          <div
            data-slot="audio-memo-action"
            className={cn(
              ACTION_MOTION,
              expanded
                ? 'pointer-events-auto -translate-y-15/4 scale-100 opacity-100 delay-[70ms] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
                : 'pointer-events-none translate-y-0 scale-50 opacity-0 duration-200 ease-[cubic-bezier(0.64,0,0.78,0)]',
            )}
          >
            <Button
              size="icon"
              variant={recording || audio === 'error' ? 'destructive' : 'secondary'}
              aria-label={audioLabel}
              tabIndex={expanded ? 0 : -1}
              className={cn('size-full rounded-full shadow-lg', ACTION_BUTTON_MOTION)}
              onClick={() => run(plus.onAudio)}
            >
              {audio === 'transcribing' ? (
                <Spinner className="size-5" />
              ) : recording ? (
                <Square aria-hidden fill="currentColor" className="size-4" />
              ) : (
                <MicIcon className="size-6" />
              )}
            </Button>
          </div>
        ) : null}
      </div>
    </>
  )
}
