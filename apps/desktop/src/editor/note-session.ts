/**
 * The save pipeline + external-change reconciliation for one open note
 * (Plan 05 steps 4-5), as a pure state machine.
 */
export { createNoteSession } from './note-session-state.ts'
export { frontmatterPatchToYaml } from './note-session-frontmatter.ts'
export { INITIAL_NOTE_SNAPSHOT } from './note-session-types.ts'
export type { FrontmatterPatch } from './note-session-frontmatter.ts'
export type {
  ConflictCopy,
  NoteContentOrigin,
  NoteSession,
  NoteSessionIo,
  NoteSessionOptions,
  NoteSessionSnapshot,
  NoteSessionStatus,
} from './note-session-types.ts'
