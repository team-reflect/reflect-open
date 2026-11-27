import { useCallback } from 'react'
import { copyNoteDeepLink, copyNotePath, routeForPath } from '@reflect/app'
import { errorMessage } from '@reflect/core'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { getNoteMenuItems, type NoteMenuItemId, type NoteMenuTarget } from './note-menu.ts'

export type NoteMenuRequest =
  | {
      surface: 'allNotes'
      notes: readonly NoteMenuTarget[]
      onTrash: (paths: readonly string[]) => void
    }
  | { surface: 'sidebar'; notes: readonly NoteMenuTarget[]; onTrash?: undefined }

export function useOpenNoteMenu(): (request: NoteMenuRequest) => void {
  const services = useCoreServices()
  const app = useAppServices()
  const navigateNoteLink = useNoteLinkNavigation()

  return useCallback(
    (request: NoteMenuRequest) => {
      const { noteActions, noteRows, indexQuery } = services
      const { nativeMenu, opener, operations } = app
      const { notes, surface } = request
      const [first] = notes
      if (first === undefined) {
        return
      }
      const { path } = first
      const select = (id: NoteMenuItemId): void => {
        switch (id) {
          case 'open':
          case 'open-in-new-window':
            navigateNoteLink({
              target: routeForPath(path),
              openInNewWindow: id === 'open-in-new-window',
            })
            break
          case 'pin':
            for (const note of notes) {
              if (!note.isPinned) {
                void noteActions.togglePinned(note.path)
              }
            }
            break
          case 'unpin':
            for (const note of notes) {
              void noteActions.unpin(note.path)
            }
            break
          case 'lock':
          case 'unlock':
            void noteActions.togglePrivate(path)
            break
          case 'copy-deep-link':
            void copyNoteDeepLink(services, app, path)
            break
          case 'copy-path':
            void copyNotePath(services, app, path)
            break
          case 'reveal':
            void noteActions
              .absolutePathFor(path)
              .then((absolutePath) => opener.revealInFileManager(absolutePath))
              .catch((cause: unknown) => {
                operations.start('Revealing note').fail(errorMessage(cause))
              })
            break
          case 'trash':
            request.onTrash?.(notes.map((note) => note.path))
            break
        }
      }
      const readIsPrivate = async (): Promise<boolean | undefined> => {
        if (notes.length !== 1) {
          return undefined
        }
        return (
          noteRows.get().get(path)?.isPrivate ??
          (await indexQuery.getNote(path))?.isPrivate ??
          false
        )
      }
      void readIsPrivate()
        .then((isPrivate) => {
          return nativeMenu.openContextMenu({
            items: getNoteMenuItems(notes, { surface, isPrivate }),
            onSelect: (id) => select(id as NoteMenuItemId),
          })
        })
        .catch((cause: unknown) => {
          operations.start('Opening note menu').fail(errorMessage(cause))
        })
    },
    [services, app, navigateNoteLink],
  )
}
