import type { ReactElement } from 'react'
import { getTaskKey } from '@reflect/core'
import { routeForPath } from '@reflect/app'
import {
  useMobileAudioMemo,
  useMobileAudioMemoAvailable,
  useMobileAudioMemoPhase,
} from '@/mobile/audio-memo-provider.tsx'
import { useChromeRenderer } from '@/mobile/chrome/chrome-renderer.ts'
import { MobileTaskEditSheet } from '@/mobile/task-edit-sheet.tsx'
import { useNewTaskSheet } from '@/mobile/use-new-task-sheet.ts'
import { useRouterActions } from '@/routing/router.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The Daily screen's `+`: new note, new task, and audio memo. The chrome
 * renderer draws the menu. New task opens the Tasks tab's quick-edit sheet
 * over the Daily screen, on a fresh task in today's note.
 */
export function DailyCaptureMenu(): ReactElement {
  const { noteCreation } = useCoreServices()
  const { toggle } = useMobileAudioMemo()
  const phase = useMobileAudioMemoPhase()
  const available = useMobileAudioMemoAvailable()
  const newTask = useNewTaskSheet()
  const { navigate } = useRouterActions()
  const chromeRenderer = useChromeRenderer()

  return (
    <>
      <chromeRenderer.Plus
        plus={{
          kind: 'capture',
          audio: available ? phase : null,
          onNote: () => navigate({ kind: 'note', path: noteCreation.untitledNotePath() }),
          onTask: () => newTask.start(),
          onAudio: toggle,
        }}
      />

      {newTask.task !== null ? (
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
      ) : null}
    </>
  )
}
