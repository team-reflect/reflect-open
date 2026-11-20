import type { AttachmentInsertTarget, CoreServices } from '@reflect/core'
import type { DialogService } from '../app/dialog-service.ts'

/**
 * The Attach file… command for the note whose editor `findEditor` finds:
 * the native file picker, then `AttachmentService.attachFilesToNote`. No-ops
 * without an open graph or a mounted editor, and when the graph changed while
 * the picker was open.
 */
export async function attachFilesToNote(
  { attachments, graphSession }: CoreServices,
  dialog: DialogService,
  findEditor: () => AttachmentInsertTarget | null,
): Promise<void> {
  const { session } = graphSession.get()
  if (session === null || findEditor() === null) {
    return
  }
  const sources = await dialog.pickFiles({ multiple: true, title: 'Attach files' })
  if (sources === null || graphSession.get().session !== session) {
    return
  }
  await attachments.attachFilesToNote({ sources, findEditor })
}
