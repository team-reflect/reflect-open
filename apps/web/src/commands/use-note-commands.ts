import {
  attachFilesToNote,
  copyNoteDeepLink,
  copyNotePath,
  publishGistAndCopyLink,
  routeForPath,
} from '@reflect/app'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { useCommandHandler } from './use-commands.ts'

/**
 * Register the commands that act on the note at `path`. With a `null` path
 * (a screen that edits no note) they have no handler.
 */
export function useNoteCommands(path: string | null): void {
  const services = useCoreServices()
  const app = useAppServices()

  // Converting the path back to a route also canonicalizes Today to a dated
  // daily link, so every way of opening the day dedupes to the same window.
  useCommandHandler(
    'note.openInNewWindow',
    path === null
      ? undefined
      : async () => {
          await app.linkNavigation.openRouteInNewWindow(routeForPath(path))
        },
  )
  // `togglePinned` updates the shared note rows before the file write, so
  // every pin surface reacts at once.
  useCommandHandler(
    'note.togglePin',
    path === null
      ? undefined
      : async () => {
          await services.noteActions.togglePinned(path)
        },
  )
  useCommandHandler(
    'note.togglePrivate',
    path === null
      ? undefined
      : async () => {
          await services.noteActions.togglePrivate(path)
        },
  )
  // `GistPublishService.publish` owns the progress line and the failure
  // surface; `publishGistAndCopyLink` owns the "link copied" confirmation.
  useCommandHandler(
    'note.publishGist',
    path === null ? undefined : () => publishGistAndCopyLink(services, app, path),
  )
  // Native file picker, then a markdown link per file at the caret: the
  // keyboard-native twin of dropping a file on the note.
  useCommandHandler(
    'note.attachFile',
    path === null
      ? undefined
      : () => attachFilesToNote(services, app.dialog, () => noteEditorHandleFor(path)),
  )
  // Id-shaped, so the link survives renames; the first copy mints the
  // frontmatter id. `copyNoteDeepLink` owns all feedback.
  useCommandHandler(
    'note.copyDeepLink',
    path === null ? undefined : () => copyNoteDeepLink(services, app, path),
  )
  // For use outside Reflect, where a reflect:// address cannot resolve.
  useCommandHandler(
    'note.copyPath',
    path === null ? undefined : () => copyNotePath(services, app, path),
  )
}
