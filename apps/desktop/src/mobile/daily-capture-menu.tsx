import { useState, type ReactElement } from 'react'
import { untitledNotePath } from '@reflect/core'
import { CircleCheck, Plus, Square } from 'lucide-react'
import { MicIcon } from '@/components/icons/mic-icon.tsx'
import { PencilIcon } from '@/components/icons/pencil-icon.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { taskKey } from '@/lib/tasks/task-identity.ts'
import { cn } from '@/lib/utils.ts'
import { useMobileAudioMemo } from '@/mobile/audio-memo-provider.tsx'
import { hapticImpactLight } from '@/mobile/haptics.ts'
import { MobileTaskEditSheet } from '@/mobile/task-edit-sheet.tsx'
import { useNewTaskSheet } from '@/mobile/use-new-task-sheet.ts'
import { routeForPath } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'

const ACTIONS_ID = 'daily-capture-actions'
const ACTION_MOTION =
  'absolute inset-0 origin-center transition-[translate,scale,opacity] will-change-[translate,scale,opacity] motion-reduce:transition-none'
const ACTION_BUTTON_MOTION =
  'transition-[background-color,color,box-shadow,translate,scale] duration-100 ease-out active:translate-y-0 active:scale-[0.94] motion-reduce:transition-none'

/**
 * The Daily screen's compact capture speed dial. The persistent `+` expands
 * into new-note, new-task, and audio-memo actions along one anchored vertical
 * path. The action wrappers remain mounted so a rapid second tap reverses from
 * their live on-screen transforms instead of restarting or jumping. New task
 * opens the Tasks tab's quick-edit sheet over the Daily screen, on a fresh task
 * in today's note.
 */
export function DailyCaptureMenu(): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const memo = useMobileAudioMemo()
  const newTask = useNewTaskSheet()
  const { navigate } = useRouter()
  const recording = memo.phase === 'recording' || memo.phase === 'requesting'
  const audioLabel =
    memo.phase === 'error'
      ? 'Show audio memo error'
      : recording
        ? 'Stop recording'
        : 'Record audio memo'

  const close = (): void => {
    setExpanded(false)
  }

  const toggleExpanded = (): void => {
    hapticImpactLight()
    setExpanded((current) => !current)
  }

  const createNote = (): void => {
    close()
    navigate({ kind: 'note', path: untitledNotePath() })
  }

  const createTask = (): void => {
    close()
    newTask.start()
  }

  const toggleAudioMemo = (): void => {
    close()
    memo.toggle()
  }

  return (
    <div
      className="fixed right-4 z-40 size-12"
      style={{
        bottom: 'calc(max(env(safe-area-inset-bottom), var(--keyboard-height, 0px)) + 4.25rem)',
      }}
    >
      <Button
        size="icon"
        aria-label={expanded ? 'Hide capture actions' : 'Show capture actions'}
        aria-controls={ACTIONS_ID}
        aria-expanded={expanded}
        className={cn('relative z-10 size-12 rounded-full shadow-lg', ACTION_BUTTON_MOTION)}
        onClick={toggleExpanded}
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
              ? 'pointer-events-auto z-[1] -translate-y-[3.75rem] scale-100 opacity-100 duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
              : 'pointer-events-none z-[1] translate-y-0 scale-50 opacity-0 delay-[50ms] duration-200 ease-[cubic-bezier(0.64,0,0.78,0)]',
          )}
        >
          <Button
            size="icon"
            variant="secondary"
            aria-label="New note"
            tabIndex={expanded ? 0 : -1}
            className={cn('size-12 rounded-full shadow-lg', ACTION_BUTTON_MOTION)}
            onClick={createNote}
          >
            <PencilIcon className="size-6" />
          </Button>
        </div>

        <div
          data-slot="new-task-action"
          className={cn(
            ACTION_MOTION,
            expanded
              ? 'pointer-events-auto -translate-y-[7.5rem] scale-100 opacity-100 delay-[35ms] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
              : 'pointer-events-none translate-y-0 scale-50 opacity-0 delay-[25ms] duration-200 ease-[cubic-bezier(0.64,0,0.78,0)]',
          )}
        >
          <Button
            size="icon"
            variant="secondary"
            aria-label="New task"
            tabIndex={expanded ? 0 : -1}
            className={cn('size-12 rounded-full shadow-lg', ACTION_BUTTON_MOTION)}
            onClick={createTask}
          >
            <CircleCheck aria-hidden className="size-5" />
          </Button>
        </div>

        {memo.available ? (
          <div
            data-slot="audio-memo-action"
            className={cn(
              ACTION_MOTION,
              expanded
                ? 'pointer-events-auto -translate-y-[11.25rem] scale-100 opacity-100 delay-[70ms] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
                : 'pointer-events-none translate-y-0 scale-50 opacity-0 duration-200 ease-[cubic-bezier(0.64,0,0.78,0)]',
            )}
          >
            <Button
              size="icon"
              variant={recording || memo.phase === 'error' ? 'destructive' : 'secondary'}
              aria-label={audioLabel}
              tabIndex={expanded ? 0 : -1}
              className={cn('size-12 rounded-full shadow-lg', ACTION_BUTTON_MOTION)}
              onClick={toggleAudioMemo}
            >
              {memo.phase === 'transcribing' ? (
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

      {newTask.task !== null ? (
        <MobileTaskEditSheet
          key={taskKey(newTask.task)}
          task={newTask.task}
          open={newTask.open}
          onOpenChange={newTask.setOpen}
          today={newTask.today}
          actions={newTask.actions}
          onOpenNote={(path) => navigate(routeForPath(path))}
          autoFocusEditor
        />
      ) : null}
    </div>
  )
}
