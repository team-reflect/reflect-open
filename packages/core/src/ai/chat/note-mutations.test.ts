import type { ToolExecutionOptions } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { hashContent } from '../../indexing/hash'
import {
  applyExactReplacements,
  prepareExactNoteEdit,
  prepareNoteAppend,
  type ChatNoteToolHost,
  type NoteMutationOutput,
} from './note-mutations'
import { buildNoteTools, type AnyNoteTools, type WritableNoteTools } from './tools'
import { MAX_NOTE_CONTENT_CHARS } from './read-notes'
import type { ChatSourceRef } from './transcript'
import { appendToNoteInput, createNoteInput } from './write-tools'

const CALL: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: 'tool-1',
  messages: [],
  context: {},
}

function requireWritable(tools: AnyNoteTools): asserts tools is WritableNoteTools {
  if (!('edit_note' in tools)) {
    throw new Error('expected writable tools')
  }
}

function mutationSuccess(path = 'notes/atlas.md'): Extract<NoteMutationOutput, { ok: true }> {
  return {
    ok: true,
    changeId: 'change-1',
    path,
    revision: 'b'.repeat(64),
    addedLines: 1,
    removedLines: 1,
  }
}

describe('exact note mutation preparation', () => {
  it('applies several exact anchors against the original body', () => {
    expect(
      applyExactReplacements('alpha beta gamma', [
        { oldText: 'alpha', newText: 'A' },
        { oldText: 'gamma', newText: 'G' },
      ]),
    ).toEqual({ ok: true, body: 'A beta G' })
  })

  it('refuses missing, repeated, and overlapping anchors', () => {
    expect(applyExactReplacements('alpha', [{ oldText: 'missing', newText: 'x' }])).toMatchObject({
      ok: false,
      code: 'missing',
    })
    expect(
      applyExactReplacements('alpha alpha', [{ oldText: 'alpha', newText: 'x' }]),
    ).toMatchObject({ ok: false, code: 'ambiguous' })
    expect(
      applyExactReplacements('abcdef', [
        { oldText: 'abc', newText: 'x' },
        { oldText: 'bcd', newText: 'y' },
      ]),
    ).toMatchObject({ ok: false, code: 'ambiguous' })
  })

  it('refuses a whole-body replacement anchor', () => {
    const body = '# Atlas\n\nOld plan.\n'
    expect(
      applyExactReplacements(body, [
        { oldText: body, newText: '# Atlas\n\nCompletely rewritten plan.\n' },
      ]),
    ).toMatchObject({ ok: false, code: 'protected' })
  })

  it('preserves frontmatter byte-for-byte and refuses title edits', async () => {
    const source = '---\r\nid: 01abc # keep\r\n---\r\n# Atlas\r\n\r\nOld plan.\r\n'
    const revision = await hashContent(source)
    const prepared = await prepareExactNoteEdit({
      path: 'notes/atlas.md',
      expectedRevision: revision,
      replacements: [{ oldText: 'Old plan.', newText: 'New plan.' }],
      readNote: async () => source,
    })
    expect(prepared).toMatchObject({ ok: true })
    if (prepared.ok) {
      expect(prepared.afterSource).toBe(
        '---\r\nid: 01abc # keep\r\n---\r\n# Atlas\r\n\r\nNew plan.\r\n',
      )
    }

    await expect(
      prepareExactNoteEdit({
        path: 'notes/atlas.md',
        expectedRevision: revision,
        replacements: [{ oldText: '# Atlas', newText: '# Renamed' }],
        readNote: async () => source,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'protected' })
  })

  it('fails closed for stale, private, conflicted, and ineligible notes', async () => {
    await expect(
      prepareExactNoteEdit({
        path: 'notes/a.md',
        expectedRevision: '0'.repeat(64),
        replacements: [{ oldText: 'body', newText: 'next' }],
        readNote: async () => '# A\n\nbody\n',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'stale' })

    for (const [path, source, code] of [
      ['notes/private.md', '---\nprivate: true\n---\n# Private\n\nbody\n', 'private'],
      [
        'notes/conflict.md',
        '# Conflict\n\n<<<<<<< this device\na\n=======\nb\n>>>>>>> other device\n',
        'conflict',
      ],
      ['templates/meeting.md', '# Meeting\n\nbody\n', 'invalid_path'],
    ] as const) {
      await expect(
        prepareExactNoteEdit({
          path,
          expectedRevision: await hashContent(source),
          replacements: [{ oldText: 'body', newText: 'next' }],
          readNote: async () => source,
        }),
      ).resolves.toMatchObject({ ok: false, code })
    }
  })

  it('appends using the note body line-ending convention', async () => {
    const source = '---\r\nid: 01abc\r\n---\r\n# Atlas\r\n'
    const prepared = await prepareNoteAppend({
      path: 'notes/atlas.md',
      expectedRevision: await hashContent(source),
      markdown: '- Added',
      readNote: async () => source,
    })
    expect(prepared).toMatchObject({ ok: true })
    if (prepared.ok) {
      expect(prepared.afterSource).toBe('---\r\nid: 01abc\r\n---\r\n# Atlas\r\n\r\n- Added\r\n')
    }
  })
})

describe('write-mode note tools', () => {
  it('validates append and create bodies without trimming Markdown bytes', () => {
    const markdown = '    indented code  \n'
    expect(
      appendToNoteInput.parse({
        path: 'notes/atlas.md',
        revision: 'a'.repeat(64),
        markdown,
      }).markdown,
    ).toBe(markdown)
    expect(createNoteInput.parse({ title: 'Launch', body: markdown }).body).toBe(markdown)
    expect(() =>
      appendToNoteInput.parse({
        path: 'notes/atlas.md',
        revision: 'a'.repeat(64),
        markdown: '   ',
      }),
    ).toThrow()
  })

  it('does not advertise mutation tools in read mode', () => {
    const tools = buildNoteTools({ permissionMode: 'read' })
    expect(Object.keys(tools)).not.toContain('edit_note')
    expect(Object.keys(tools)).not.toContain('append_to_note')
    expect(Object.keys(tools)).not.toContain('create_note')
  })

  it('requires read_notes in the same turn before applying an edit', async () => {
    const source = '# Atlas\n\nOld plan.\n'
    const applyChange = vi.fn<ChatNoteToolHost['applyChange']>(async () => mutationSuccess())
    const host: ChatNoteToolHost = {
      readNote: async () => source,
      applyChange,
      createNote: async () => mutationSuccess(),
    }
    const tools = buildNoteTools({ permissionMode: 'readWrite', noteHost: host })
    requireWritable(tools)
    const revision = await hashContent(source)
    const executeEdit = tools.edit_note.execute
    const executeRead = tools.read_notes.execute
    if (executeEdit === undefined || executeRead === undefined) {
      expect.unreachable('tools must be executable')
    }

    const refused = await executeEdit(
      {
        path: 'notes/atlas.md',
        revision,
        replacements: [{ oldText: 'Old plan.', newText: 'New plan.' }],
      },
      CALL,
    )
    expect(refused).toMatchObject({ ok: false, code: 'not_read' })
    expect(applyChange).not.toHaveBeenCalled()

    await executeRead({ paths: ['notes/atlas.md'] }, CALL)
    const applied = await executeEdit(
      {
        path: 'notes/atlas.md',
        revision,
        replacements: [{ oldText: 'Old plan.', newText: 'New plan.' }],
      },
      CALL,
    )
    expect(applied).toEqual(mutationSuccess())
    expect(applyChange).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'edit',
        toolCallId: 'tool-1',
        expectedRevision: revision,
        beforeSource: source,
        afterSource: '# Atlas\n\nNew plan.\n',
      }),
    )
  })

  it('does not edit anchors beyond a truncated read_notes prefix', async () => {
    const source = `# Large\n\n${'x'.repeat(MAX_NOTE_CONTENT_CHARS)}\nHidden anchor\n`
    const applyChange = vi.fn<ChatNoteToolHost['applyChange']>(async () => mutationSuccess())
    const tools = buildNoteTools({
      permissionMode: 'readWrite',
      noteHost: {
        readNote: async () => source,
        applyChange,
        createNote: async () => mutationSuccess(),
      },
    })
    requireWritable(tools)
    const executeRead = tools.read_notes.execute
    const executeEdit = tools.edit_note.execute
    if (executeRead === undefined || executeEdit === undefined) {
      expect.unreachable('tools must be executable')
    }
    await executeRead({ paths: ['notes/large.md'] }, CALL)
    const outcome = await executeEdit(
      {
        path: 'notes/large.md',
        revision: await hashContent(source),
        replacements: [{ oldText: 'Hidden anchor', newText: 'Changed' }],
      },
      CALL,
    )
    expect(outcome).toMatchObject({ ok: false, code: 'missing' })
    expect(applyChange).not.toHaveBeenCalled()
  })

  it('observes only successful edit, append, and create outcomes', async () => {
    const source = '# Atlas\n\nOld plan.\n'
    const observed: ChatSourceRef[] = []
    const host: ChatNoteToolHost = {
      readNote: async () => source,
      applyChange: async () => mutationSuccess(),
      createNote: async () => mutationSuccess('notes/launch.md'),
    }
    const tools = buildNoteTools({
      permissionMode: 'readWrite',
      noteHost: host,
      observeSource: (sourceRef) => {
        observed.push(sourceRef)
      },
    })
    requireWritable(tools)
    const revision = await hashContent(source)
    const executeRead = tools.read_notes.execute
    const executeEdit = tools.edit_note.execute
    const executeAppend = tools.append_to_note.execute
    const executeCreate = tools.create_note.execute
    if (
      executeRead === undefined ||
      executeEdit === undefined ||
      executeAppend === undefined ||
      executeCreate === undefined
    ) {
      expect.unreachable('tools must be executable')
    }

    await executeRead({ paths: ['notes/atlas.md'] }, CALL)
    await executeEdit(
      {
        path: 'notes/atlas.md',
        revision,
        replacements: [{ oldText: 'Old plan.', newText: 'New plan.' }],
      },
      CALL,
    )
    await executeAppend({ path: 'notes/atlas.md', revision, markdown: '- Follow up' }, CALL)
    await executeCreate({ title: 'Launch' }, CALL)

    expect(observed).toEqual([
      { kind: 'note', path: 'notes/atlas.md' },
      { kind: 'note', path: 'notes/atlas.md' },
      { kind: 'note', path: 'notes/atlas.md' },
      { kind: 'note', path: 'notes/launch.md' },
    ])
  })

  it('strips host-only fields from the model-facing mutation result', async () => {
    const hostOutcome = {
      ...mutationSuccess('notes/launch.md'),
      title: 'Host-only title',
      afterSource: '# Launch\n\nPrivate checkpoint bytes.\n',
    }
    const tools = buildNoteTools({
      permissionMode: 'readWrite',
      noteHost: {
        readNote: async () => '# Note\n',
        applyChange: async () => hostOutcome,
        createNote: async () => hostOutcome,
      },
    })
    requireWritable(tools)
    const executeCreate = tools.create_note.execute
    if (executeCreate === undefined) {
      expect.unreachable('create_note must be executable')
    }

    await expect(executeCreate({ title: 'Launch' }, CALL)).resolves.toEqual(
      mutationSuccess('notes/launch.md'),
    )
  })
})
