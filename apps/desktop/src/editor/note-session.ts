/**
 * The save pipeline + external-change reconciliation for one open note
 * (Plan 05 steps 4-5), as a pure state machine.
 */
export { createNoteSession } from './note-session-state'
export { frontmatterPatchToYaml } from './note-session-frontmatter'
export { INITIAL_NOTE_SNAPSHOT } from './note-session-types'
export type { FrontmatterPatch } from './note-session-frontmatter'
export type {
  NoteBodyMutationOptions,
  NoteBodyMutationPreparation,
  NoteBodyMutationRefusal,
  NoteBodyMutationResult,
  NoteConditionalTrashOptions,
  NoteConditionalTrashResult,
  NoteContentOrigin,
  NoteFreshContent,
  NoteSession,
  NoteSessionIo,
  NoteSessionOptions,
  NoteSessionSnapshot,
  NoteSessionStatus,
} from './note-session-types'
