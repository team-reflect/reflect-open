import {
  attachFilesToNote,
  copyNoteDeepLink,
  copyNotePath,
  publishGistAndCopyLink,
  routeForPath,
  type AppServices,
} from '@reflect/app'
import type { CoreServices } from '@reflect/core'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { useCommands, type CommandHandlers } from './use-commands.ts'

function noteCommandHandlers(
  services: CoreServices,
  app: AppServices,
  path: string,
): CommandHandlers {
  return {
    // Converting the path back to a route also canonicalizes Today to a dated
    // daily link, so every way of opening the day dedupes to the same window.
    'note.openInNewWindow': async () => {
      await app.linkNavigation.openRouteInNewWindow(routeForPath(path))
    },
    // `togglePinned` updates the shared note rows before the file write, so
    // every pin surface reacts at once.
    'note.togglePin': async () => {
      await services.noteActions.togglePinned(path)
    },
    'note.togglePrivate': async () => {
      await services.noteActions.togglePrivate(path)
    },
    // `GistPublishService.publish` owns the progress line and the failure
    // surface; `publishGistAndCopyLink` owns the "link copied" confirmation.
    'note.publishGist': () => publishGistAndCopyLink(services, app, path),
    // Native file picker, then a markdown link per file at the caret: the
    // keyboard-native twin of dropping a file on the note.
    'note.attachFile': () => {
      return attachFilesToNote(services, app.dialog, () => noteEditorHandleFor(path))
    },
    // Id-shaped, so the link survives renames; the first copy mints the
    // frontmatter id. `copyNoteDeepLink` owns all feedback.
    'note.copyDeepLink': () => copyNoteDeepLink(services, app, path),
    // For use outside Reflect, where a reflect:// address cannot resolve.
    'note.copyPath': () => copyNotePath(services, app, path),
  }
}

/**
 * Register the commands that act on the note at `path`. With a `null` path
 * (a screen that edits no note) they have no handler.
 */
export function useNoteCommands(path: string | null): void {
  const services = useCoreServices()
  const app = useAppServices()
  useCommands(path === null ? {} : noteCommandHandlers(services, app, path))
}
