import type { CommandContext } from './command-service.ts'

/**
 * The Attach file… command for the routed note: the native file picker, then
 * `AttachmentService.attachFilesToNote`. No-ops without an open graph, a
 * routed note or a mounted editor, and when the graph changed while the picker was open.
 */
export async function attachFilesToNote(context: CommandContext): Promise<void> {
  const notePath = context.notePath()
  if (notePath === null) {
    return
  }
  const { attachments, graphSession } = context.services
  const { dialog } = context.app
  const findEditor = () => context.noteEditor(notePath)
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
