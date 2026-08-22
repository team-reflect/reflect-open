import { tool, type Tool } from 'ai'
import { z } from 'zod'
import {
  prepareExactNoteEdit,
  prepareNoteAppend,
  type ChatNoteToolHost,
  type NoteMutationOutput,
} from './note-mutations'
import type { ChatSourceRef } from './transcript'

const noteRevision = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .describe('Revision returned by read_notes for this exact note source')

export const editNoteInput = z.object({
  path: z.string().min(1).describe('Graph-relative note path returned by read_notes'),
  revision: noteRevision,
  replacements: z
    .array(
      z.object({
        oldText: z.string().min(1).describe('Exact text copied from the note body'),
        newText: z.string().describe('Replacement markdown; may be empty to delete the old text'),
      }),
    )
    .min(1)
    .max(50)
    .describe('Non-overlapping exact replacements, each matching once in the original body'),
})

export const appendToNoteInput = z.object({
  path: z.string().min(1).describe('Graph-relative note path returned by read_notes'),
  revision: noteRevision,
  markdown: z
    .string()
    .refine((markdown) => markdown.trim().length > 0, 'non-empty markdown')
    .describe('Markdown block to append to the note body'),
})

export const createNoteInput = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .regex(/^[^\r\n]+$/, 'a single-line note title')
    .describe('Title for the new regular note'),
  body: z
    .string()
    .refine((body) => body.trim().length > 0, 'non-empty markdown')
    .optional()
    .describe('Optional markdown below the title'),
})

/** The mutation-only half of a write-enabled chat tool set. */
export type MutationNoteTools = {
  edit_note: Tool<z.infer<typeof editNoteInput>, NoteMutationOutput>
  append_to_note: Tool<z.infer<typeof appendToNoteInput>, NoteMutationOutput>
  create_note: Tool<z.infer<typeof createNoteInput>, NoteMutationOutput>
}

/** The exact read_notes material a mutation tool is allowed to rely on. */
export interface NoteReadGrant {
  revision: string
  visibleContent: string
  truncated: boolean
}

/** Build mutation tools over one stream's current-turn read-revision ledger. */
export function buildWriteNoteTools(
  noteHost: ChatNoteToolHost,
  readGrants: ReadonlyMap<string, NoteReadGrant>,
  observeSource?: (source: ChatSourceRef) => void,
): MutationNoteTools {
  return {
    edit_note: tool({
      description:
        'Edit one non-private note body using exact text copied from read_notes. Every oldText ' +
        'must occur exactly once and replacements cannot overlap. Use the revision from the same ' +
        'turn. This cannot change frontmatter or the note title.',
      inputSchema: editNoteInput,
      execute: async ({ path, revision, replacements }, { toolCallId }) => {
        const refusal = requireCurrentRead(readGrants, path, revision)
        if (refusal !== null) {
          return refusal
        }
        const grant = readGrants.get(path)
        if (
          grant?.truncated === true &&
          replacements.some((replacement) => !grant.visibleContent.includes(replacement.oldText))
        ) {
          return {
            ok: false,
            code: 'missing',
            message: 'An exact replacement anchor was outside the content returned by read_notes.',
          }
        }
        const prepared = await prepareExactNoteEdit({
          path,
          expectedRevision: revision,
          replacements,
          readNote: (notePath) => noteHost.readNote(notePath),
        })
        if (!prepared.ok) {
          return prepared
        }
        const outcome = await safeHostMutation(() =>
          noteHost.applyChange({
            kind: 'edit',
            toolCallId,
            path: prepared.path,
            title: prepared.title,
            beforeSource: prepared.beforeSource,
            afterSource: prepared.afterSource,
            expectedRevision: prepared.revision,
          }),
        )
        observeSuccessfulMutation(outcome, observeSource)
        return outcome
      },
    }),
    append_to_note: tool({
      description:
        'Append a markdown block to one non-private note. Use the exact path and revision returned ' +
        'by read_notes in this turn. This cannot change frontmatter or the note title.',
      inputSchema: appendToNoteInput,
      execute: async ({ path, revision, markdown }, { toolCallId }) => {
        const refusal = requireCurrentRead(readGrants, path, revision)
        if (refusal !== null) {
          return refusal
        }
        const prepared = await prepareNoteAppend({
          path,
          expectedRevision: revision,
          markdown,
          readNote: (notePath) => noteHost.readNote(notePath),
        })
        if (!prepared.ok) {
          return prepared
        }
        const outcome = await safeHostMutation(() =>
          noteHost.applyChange({
            kind: 'append',
            toolCallId,
            path: prepared.path,
            title: prepared.title,
            beforeSource: prepared.beforeSource,
            afterSource: prepared.afterSource,
            expectedRevision: prepared.revision,
          }),
        )
        observeSuccessfulMutation(outcome, observeSource)
        return outcome
      },
    }),
    create_note: tool({
      description:
        'Create a new public regular note with a title and optional markdown body. Reflect chooses ' +
        'a collision-safe path and identity. Use only when the user asked to create a note.',
      inputSchema: createNoteInput,
      execute: async ({ title, body }, { toolCallId }) => {
        const outcome = await safeHostMutation(() =>
          noteHost.createNote({ toolCallId, title, body }),
        )
        observeSuccessfulMutation(outcome, observeSource)
        return outcome
      },
    }),
  }
}

function observeSuccessfulMutation(
  outcome: NoteMutationOutput,
  observe: ((source: ChatSourceRef) => void) | undefined,
): void {
  if (outcome.ok) {
    observe?.({ kind: 'note', path: outcome.path })
  }
}

function requireCurrentRead(
  grants: ReadonlyMap<string, NoteReadGrant>,
  path: string,
  revision: string,
): Extract<NoteMutationOutput, { ok: false }> | null {
  return grants.get(path)?.revision === revision
    ? null
    : {
        ok: false,
        code: 'not_read',
        message: 'Read this note in the current turn before editing it.',
      }
}

async function safeHostMutation(
  run: () => Promise<NoteMutationOutput>,
): Promise<NoteMutationOutput> {
  try {
    const outcome = await run()
    return outcome.ok
      ? {
          ok: true,
          changeId: outcome.changeId,
          path: outcome.path,
          revision: outcome.revision,
          addedLines: outcome.addedLines,
          removedLines: outcome.removedLines,
        }
      : { ok: false, code: outcome.code, message: outcome.message }
  } catch {
    return { ok: false, code: 'failed', message: 'The note change could not be applied.' }
  }
}
