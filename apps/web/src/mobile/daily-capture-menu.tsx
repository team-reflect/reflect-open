import type { ReactElement } from 'react'
import { getTaskKey } from '@reflect/core'
import { routeForPath } from '@reflect/app'
import {
  useMobileAudioMemo,
  useMobileAudioMemoAvailable,
  useMobileAudioMemoPhase,
} from '@/mobile/audio-memo-provider.tsx'
import type { ChromePlus } from '@/mobile/chrome/screen-chrome.ts'
import { MobileTaskEditSheet } from '@/mobile/task-edit-sheet.tsx'
import { useNewTaskSheet } from '@/mobile/use-new-task-sheet.ts'
import { useRouterActions } from '@/routing/router.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The Daily screen's `+`: new note, new task, and audio memo, and the sheet
 * of the new task. New task opens the Tasks tab's quick-edit sheet over the
 * Daily screen, on a fresh task in today's note.
 */
export function useDailyCapture(): { plus: ChromePlus; sheet: ReactElement | null } {
  const { noteCreation } = useCoreServices()
  const { toggle } = useMobileAudioMemo()
  const phase = useMobileAudioMemoPhase()
  const available = useMobileAudioMemoAvailable()
  const newTask = useNewTaskSheet()
  const { navigate } = useRouterActions()

  return {
    plus: {
      kind: 'capture',
      audio: available ? phase : null,
      onNote: () => navigate({ kind: 'note', path: noteCreation.untitledNotePath() }),
      onTask: () => newTask.start(),
      onAudio: toggle,
    },
    sheet:
      newTask.task === null ? null : (
        <MobileTaskEditSheet
          key={getTaskKey(newTask.task)}
          task={newTask.task}
          open={newTask.open}
          onOpenChange={newTask.setOpen}
          today={newTask.today}
          actions={newTask.actions}
          onOpenNote={(path) => navigate(routeForPath(path))}
          autoFocusEditor
        />
      ),
  }
}
