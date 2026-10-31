import type { AppServices } from '@reflect/app'
import { errorMessage, type CoreServices } from '@reflect/core'

/**
 * Put the note's deep link on the clipboard and confirm through the
 * operations status line. Never rejects; does nothing when no graph is open.
 */
export async function copyNoteDeepLink(
  { noteActions, graphSession }: CoreServices,
  { clipboard, operations }: AppServices,
  path: string,
): Promise<void> {
  if (graphSession.getState().session === null) {
    return
  }
  let url: string
  try {
    url = await noteActions.deepLinkFor(path)
  } catch (cause) {
    operations.start('Copying deep link').fail(errorMessage(cause))
    return
  }
  try {
    await clipboard.writeText(url)
    operations.start('Deep link copied').done()
  } catch (cause) {
    operations.start('Copying deep link').fail(errorMessage(cause))
  }
}

/**
 * Put the note's absolute filesystem path on the clipboard and report through
 * the operations status line. Never rejects.
 */
export async function copyNotePath(
  { noteActions, graphSession }: CoreServices,
  { clipboard, operations }: AppServices,
  path: string,
): Promise<void> {
  if (graphSession.getState().session === null) {
    operations.start('Copying note path').fail('No graph is open')
    return
  }
  try {
    await clipboard.writeText(await noteActions.absolutePathFor(path))
    operations.start('Note path copied').done()
  } catch (cause) {
    operations.start('Copying note path').fail(errorMessage(cause))
  }
}

/**
 * Publish the note as a gist, then put the gist link on the clipboard. A
 * failed copy gets its own failure line and never reads as a failed publish.
 */
export async function publishGistAndCopyLink(
  { gistPublish }: CoreServices,
  { clipboard, operations }: AppServices,
  path: string,
): Promise<void> {
  const result = await gistPublish.publish(path)
  if (result?.url == null) {
    return
  }
  try {
    await clipboard.writeText(result.url)
    operations.start('Gist link copied').done()
  } catch (cause) {
    operations.start('Copying the gist link').fail(errorMessage(cause))
  }
}
