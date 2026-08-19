import {
  hashContent,
  PreparedNoteCreationRefusal,
  type ChatNoteChange,
  type PreparedNoteCreation,
} from '@reflect/core'
import { describe, expect, it, vi } from 'vitest'
import type {
  NoteBodyMutationOptions,
  NoteConditionalTrashOptions,
  NoteSession,
} from '@/editor/note-session'
import {
  createDesktopChatNoteChangeService,
  createDesktopChatNoteToolHost,
} from './ai-note-tool-host'

const BEFORE = '# Project\n\nBefore\n'
const AFTER = '# Project\n\nAfter\n'

function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
  let settle: (value: Value) => void = () => {}
  const promise = new Promise<Value>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: (value) => settle(value) }
}

function isReadNote(
  value: unknown,
): value is (path: string, generation: number) => Promise<string> {
  return typeof value === 'function'
}

function options(overrides?: Record<string, unknown>) {
  const events: string[] = []
  const overriddenRead = overrides?.['readNote']
  const readNote = isReadNote(overriddenRead) ? overriddenRead : async () => BEFORE
  const dependencies = {
    lookupSession: () => null,
    readNote: vi.fn(readNote),
    readNoteForAi: vi.fn(async (path: string, generation: number) => {
      const source = await readNote(path, generation)
      return { kind: 'content' as const, source, revision: await hashContent(source) }
    }),
    writeNoteIfRevision: vi.fn(async () => {
      events.push('write')
      return { kind: 'written' as const, revision: 'after-revision', modifiedMs: 1 }
    }),
    trashNoteIfRevision: vi.fn(async () => ({ kind: 'trashed' as const })),
    createNote: vi.fn(
      async (
        _title: string,
        _generation: number,
        _body: string | undefined,
        onPrepared: (creation: PreparedNoteCreation) => Promise<void>,
      ) => {
        const creation = {
          path: 'notes/new-note.md',
          source: '# New note\n',
          revision: await hashContent('# New note\n'),
        }
        await onPrepared(creation)
        events.push('create')
        return creation
      },
    ),
    prepareChange: vi.fn(async () => {
      events.push('prepare')
      return {} as ChatNoteChange
    }),
    setChangeState: vi.fn(async (input: { id: string; state: ChatNoteChange['state'] }) => ({
      kind: 'updated' as const,
      change: { id: input.id, state: input.state } as unknown as ChatNoteChange,
    })),
    setChangesStateBatch: vi.fn(
      async (input: {
        ids: string[]
        expectedState: ChatNoteChange['state']
        state: ChatNoteChange['state']
      }) => {
        events.push(`state:${input.expectedState}->${input.state}`)
        return {
          kind: 'updated' as const,
          changes: input.ids.map((id) => ({ id, state: input.state }) as unknown as ChatNoteChange),
        }
      },
    ),
    changesForTurn: vi.fn(async () => []),
    pendingChanges: vi.fn(async () => []),
    randomId: () => 'change-1',
    now: () => 1_000,
    ...overrides,
  }
  return {
    events,
    dependencies,
    host: createDesktopChatNoteToolHost({
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies,
    }),
  }
}

async function change(overrides?: Partial<ChatNoteChange>): Promise<ChatNoteChange> {
  return {
    id: 'change-1',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    path: 'notes/project.md',
    sequence: 0,
    operation: 'edit',
    beforeSource: BEFORE,
    afterSource: AFTER,
    beforeRevision: await hashContent(BEFORE),
    afterRevision: await hashContent(AFTER),
    state: 'applied',
    errorMessage: null,
    createdMs: 1_000,
    updatedMs: 1_001,
    ...overrides,
  }
}

describe('createDesktopChatNoteToolHost', () => {
  it('passes the exact open-session owner token to the guarded AI read', async () => {
    const session = {
      ownerId: 'owner-live',
      readFreshContent: vi.fn(async (readPersisted: () => Promise<string>) => {
        const source = await readPersisted()
        return { source, revision: await hashContent(source) }
      }),
    } as unknown as NoteSession
    const setup = options({ lookupSession: () => session })

    await expect(setup.host.readNote('notes/project.md')).resolves.toBe(BEFORE)

    expect(setup.dependencies.readNoteForAi).toHaveBeenCalledWith(
      'notes/project.md',
      7,
      'owner-live',
    )
  })

  it('blocks a same-webview teardown claim once the live session is unregistered', async () => {
    const setup = options({
      lookupSession: () => null,
      readNoteForAi: vi.fn(async () => ({ kind: 'blocked' as const })),
    })

    await expect(setup.host.readNote('notes/project.md')).rejects.toThrow(
      'owned by another live editor',
    )
    expect(setup.dependencies.readNoteForAi).toHaveBeenCalledWith('notes/project.md', 7, undefined)
    expect(setup.dependencies.readNote).not.toHaveBeenCalled()
  })

  it('keeps asset-description sidecars on the ordinary pinned read path', async () => {
    const setup = options({ readNote: vi.fn(async () => 'A local image description') })

    await expect(setup.host.readNote('.reflect/asset-descriptions/diagram.png.md')).resolves.toBe(
      'A local image description',
    )

    expect(setup.dependencies.readNote).toHaveBeenCalledWith(
      '.reflect/asset-descriptions/diagram.png.md',
      7,
    )
    expect(setup.dependencies.readNoteForAi).not.toHaveBeenCalled()
  })

  it('reads a generation-pinned closed note and journals before its guarded write', async () => {
    const setup = options()
    const expectedRevision = await hashContent(BEFORE)

    await expect(setup.host.readNote('notes/project.md')).resolves.toBe(BEFORE)
    await expect(
      setup.host.applyChange({
        kind: 'edit',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: BEFORE,
        afterSource: AFTER,
        expectedRevision,
      }),
    ).resolves.toEqual({
      ok: true,
      changeId: 'change-1',
      path: 'notes/project.md',
      revision: 'after-revision',
      addedLines: 1,
      removedLines: 1,
    })

    expect(setup.events).toEqual(['prepare', 'write'])
    expect(setup.dependencies.readNoteForAi).toHaveBeenCalledWith('notes/project.md', 7, undefined)
    expect(setup.dependencies.prepareChange).toHaveBeenCalledWith({
      change: expect.objectContaining({
        id: 'change-1',
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        operation: 'edit',
        beforeSource: BEFORE,
        afterSource: AFTER,
        beforeRevision: expectedRevision,
      }),
      generation: 9,
    })
    expect(setup.dependencies.writeNoteIfRevision).toHaveBeenCalledWith(
      'notes/project.md',
      AFTER,
      expectedRevision,
      7,
    )
  })

  it('uses an open session exclusively and supplies its journal boundary', async () => {
    const expectedRevision = await hashContent(BEFORE)
    const session = {
      readFreshContent: vi.fn(async () => ({ source: BEFORE, revision: expectedRevision })),
      commitBodyMutation: vi.fn(async (mutation: NoteBodyMutationOptions) => {
        const nextBody = mutation.transform('# Project\n\nBefore\n')
        await mutation.onPrepared?.({
          beforeSource: BEFORE,
          beforeRevision: expectedRevision,
          intendedSource: AFTER,
          intendedRevision: await hashContent(AFTER),
        })
        return {
          status: 'applied' as const,
          beforeSource: BEFORE,
          beforeRevision: expectedRevision,
          afterSource: nextBody,
          afterRevision: await hashContent(nextBody),
        }
      }),
    } as unknown as NoteSession
    const setup = options({ lookupSession: () => session })

    await expect(setup.host.readNote('notes/project.md')).resolves.toBe(BEFORE)
    expect(session.readFreshContent).toHaveBeenCalledWith(expect.any(Function))
    await expect(
      setup.host.applyChange({
        kind: 'append',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: BEFORE,
        afterSource: AFTER,
        expectedRevision,
      }),
    ).resolves.toMatchObject({ ok: true, path: 'notes/project.md' })

    expect(session.commitBodyMutation).toHaveBeenCalledOnce()
    expect(setup.dependencies.writeNoteIfRevision).not.toHaveBeenCalled()
    expect(setup.events).toEqual(['prepare'])
  })

  it('uses authoritative private disk bytes instead of a stale public open buffer', async () => {
    const privateSource = '---\nprivate: true\n---\n# Project\n\nSecret\n'
    const session = {
      readFreshContent: vi.fn(async (readPersisted: () => Promise<string>) => {
        await readPersisted()
        return null
      }),
    } as unknown as NoteSession
    const setup = options({
      lookupSession: () => session,
      readNote: vi.fn(async () => privateSource),
    })

    await expect(setup.host.readNote('notes/project.md')).resolves.toBe(privateSource)
    expect(session.readFreshContent).toHaveBeenCalledWith(expect.any(Function))
  })

  it('fails closed when an open dirty buffer cannot reconcile changed disk bytes', async () => {
    const changedOnDisk = '# Project\n\nChanged elsewhere\n'
    const session = {
      readFreshContent: vi.fn(async (readPersisted: () => Promise<string>) => {
        await readPersisted()
        return null
      }),
    } as unknown as NoteSession
    const setup = options({
      lookupSession: () => session,
      readNote: vi.fn(async () => changedOnDisk),
    })

    await expect(setup.host.readNote('notes/project.md')).rejects.toThrow(
      'the open note is not ready',
    )
    expect(session.readFreshContent).toHaveBeenCalledWith(expect.any(Function))
  })

  it('records a failed checkpoint when the closed-note revision is stale', async () => {
    const setup = options({
      writeNoteIfRevision: vi.fn(async () => ({
        kind: 'stale' as const,
        currentRevision: 'newer',
      })),
    })

    await expect(
      setup.host.applyChange({
        kind: 'edit',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: BEFORE,
        afterSource: AFTER,
        expectedRevision: await hashContent(BEFORE),
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'stale',
      message: 'The note changed. Read it again before editing.',
    })
    expect(setup.dependencies.setChangeState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'prepared', state: 'failed' }),
    )
  })

  it('records a contended closed-note write as uncertain instead of applied', async () => {
    const setup = options({
      writeNoteIfRevision: vi.fn(async () => ({
        kind: 'contended' as const,
        currentRevision: 'external-revision',
      })),
    })

    await expect(
      setup.host.applyChange({
        kind: 'edit',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: BEFORE,
        afterSource: AFTER,
        expectedRevision: await hashContent(BEFORE),
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'failed',
      message: 'The note changed while the edit was being verified. Review it before retrying.',
    })
    expect(setup.dependencies.setChangeState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'prepared', state: 'uncertain' }),
    )
  })

  it('reconciles a lost write response to applied when exact after-bytes landed', async () => {
    let disk = BEFORE
    const setup = options({
      readNote: vi.fn(async () => disk),
      writeNoteIfRevision: vi.fn(async (_path: string, contents: string) => {
        disk = contents
        throw new Error('IPC response lost')
      }),
    })

    await expect(
      setup.host.applyChange({
        kind: 'edit',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: BEFORE,
        afterSource: AFTER,
        expectedRevision: await hashContent(BEFORE),
      }),
    ).resolves.toMatchObject({ ok: true, path: 'notes/project.md' })

    expect(disk).toBe(AFTER)
    expect(setup.dependencies.setChangeState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'prepared', state: 'applied' }),
    )
  })

  it('uses the exact live-session owner token to reconcile a lost open write response', async () => {
    const session = {
      ownerId: 'owner-live',
      commitBodyMutation: vi.fn(async (mutation: NoteBodyMutationOptions) => {
        await mutation.onPrepared?.({
          beforeSource: BEFORE,
          beforeRevision: await hashContent(BEFORE),
          intendedSource: AFTER,
          intendedRevision: await hashContent(AFTER),
        })
        throw new Error('IPC response lost')
      }),
    } as unknown as NoteSession
    const readNoteForAi = vi.fn(async () => ({
      kind: 'content' as const,
      source: AFTER,
      revision: await hashContent(AFTER),
    }))
    const setup = options({ lookupSession: () => session, readNoteForAi })

    await expect(
      setup.host.applyChange({
        kind: 'edit',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: BEFORE,
        afterSource: AFTER,
        expectedRevision: await hashContent(BEFORE),
      }),
    ).resolves.toMatchObject({ ok: true, path: 'notes/project.md' })
    expect(readNoteForAi).toHaveBeenCalledWith('notes/project.md', 7, 'owner-live')
  })

  it('retires a lost write response as failed when exact before-bytes remain', async () => {
    const setup = options({
      writeNoteIfRevision: vi.fn(async () => {
        throw new Error('IPC response lost before write')
      }),
    })

    await expect(
      setup.host.applyChange({
        kind: 'edit',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: BEFORE,
        afterSource: AFTER,
        expectedRevision: await hashContent(BEFORE),
      }),
    ).resolves.toMatchObject({ ok: false, code: 'failed' })
    expect(setup.dependencies.setChangeState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'prepared', state: 'failed' }),
    )
  })

  it('keeps a lost write response uncertain when current bytes match neither checkpoint', async () => {
    const setup = options({
      readNote: vi.fn(async () => '# Project\n\nExternal change\n'),
      writeNoteIfRevision: vi.fn(async () => {
        throw new Error('IPC response lost during write')
      }),
    })

    await expect(
      setup.host.applyChange({
        kind: 'edit',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: BEFORE,
        afterSource: AFTER,
        expectedRevision: await hashContent(BEFORE),
      }),
    ).resolves.toMatchObject({ ok: false, code: 'failed' })
    expect(setup.dependencies.setChangeState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'prepared', state: 'uncertain' }),
    )
  })

  it('reconciles a lost create response to applied when exact creation bytes landed', async () => {
    let disk: string | null = null
    const setup = options({
      readNote: vi.fn(async () => {
        if (disk === null) {
          throw new Error('missing')
        }
        return disk
      }),
      createNote: vi.fn(
        async (
          _title: string,
          _generation: number,
          _body: string | undefined,
          onPrepared: (creation: PreparedNoteCreation) => Promise<void>,
        ) => {
          const source = '# New note\n'
          const creation = {
            path: 'notes/new-note.md',
            source,
            revision: await hashContent(source),
          }
          await onPrepared(creation)
          disk = source
          throw new Error('IPC response lost')
        },
      ),
    })

    await expect(
      setup.host.createNote({ toolCallId: 'tool-1', title: 'New note' }),
    ).resolves.toMatchObject({ ok: true, path: 'notes/new-note.md' })

    expect(disk).toBe('# New note\n')
    expect(setup.dependencies.setChangeState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'prepared', state: 'applied' }),
    )
  })

  it('retires a lost create response as failed when the candidate remains missing', async () => {
    const setup = options({
      readNoteForAi: vi.fn(async () => ({ kind: 'missing' as const })),
      createNote: vi.fn(
        async (
          _title: string,
          _generation: number,
          _body: string | undefined,
          onPrepared: (creation: PreparedNoteCreation) => Promise<void>,
        ) => {
          const source = '# New note\n'
          await onPrepared({
            path: 'notes/new-note.md',
            source,
            revision: await hashContent(source),
          })
          throw new Error('IPC response lost before create')
        },
      ),
    })

    await expect(
      setup.host.createNote({ toolCallId: 'tool-1', title: 'New note' }),
    ).resolves.toMatchObject({ ok: false, code: 'failed' })
    expect(setup.dependencies.setChangeState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'prepared', state: 'failed' }),
    )
  })

  it('marks a definitive identical-bytes create collision failed, never uncertain', async () => {
    const source = '# New note\n'
    const setup = options({
      createNote: vi.fn(
        async (
          _title: string,
          _generation: number,
          _body: string | undefined,
          onPrepared: (creation: PreparedNoteCreation) => Promise<void>,
        ) => {
          await onPrepared({
            path: 'notes/new-note.md',
            source,
            revision: await hashContent(source),
          })
          // Another creator won with byte-identical content. Treating this as
          // uncertain could let recovery claim and later trash their file.
          throw new PreparedNoteCreationRefusal('collision')
        },
      ),
    })

    await expect(
      setup.host.createNote({ toolCallId: 'tool-1', title: 'New note' }),
    ).resolves.toMatchObject({ ok: false, code: 'failed' })
    expect(setup.dependencies.setChangeState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'prepared', state: 'failed' }),
    )
  })

  it('reports a definitive live-owner create refusal without exposing a candidate', async () => {
    const setup = options({
      createNote: vi.fn(
        async (
          _title: string,
          _generation: number,
          _body: string | undefined,
          onPrepared: (creation: PreparedNoteCreation) => Promise<void>,
        ) => {
          const source = '# Private draft\n'
          await onPrepared({
            path: 'notes/private-draft.md',
            source,
            revision: await hashContent(source),
          })
          throw new PreparedNoteCreationRefusal('blocked')
        },
      ),
    })

    await expect(
      setup.host.createNote({ toolCallId: 'tool-1', title: 'Private draft' }),
    ).resolves.toEqual({
      ok: false,
      code: 'unavailable',
      message: 'Another live editor is using this note.',
    })
    expect(setup.dependencies.setChangeState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'prepared', state: 'failed' }),
    )
  })

  it('does not report success when applied audit finalization loses its CAS', async () => {
    const setChangeState = vi.fn(async (input: { id: string; state: ChatNoteChange['state'] }) =>
      input.state === 'applied'
        ? {
            kind: 'stateMismatch' as const,
            change: {
              id: input.id,
              state: 'prepared',
            } as unknown as ChatNoteChange,
          }
        : {
            kind: 'updated' as const,
            change: { id: input.id, state: input.state } as unknown as ChatNoteChange,
          },
    )
    const setup = options({ setChangeState })

    await expect(
      setup.host.applyChange({
        kind: 'edit',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: BEFORE,
        afterSource: AFTER,
        expectedRevision: await hashContent(BEFORE),
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'failed',
      message:
        'The note changed, but its review checkpoint could not be finalized. Review it before continuing.',
    })
    expect(setup.dependencies.writeNoteIfRevision).toHaveBeenCalledOnce()
    expect(setChangeState).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedState: 'prepared', state: 'applied' }),
    )
    expect(setChangeState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedState: 'prepared', state: 'uncertain' }),
    )
  })

  it('treats a retry showing applied as the success echo for a lost finalization response', async () => {
    let appliedAttempts = 0
    const setChangeState = vi.fn(async (input: { id: string; state: ChatNoteChange['state'] }) => {
      if (input.state !== 'applied') {
        return {
          kind: 'updated' as const,
          change: { id: input.id, state: input.state } as unknown as ChatNoteChange,
        }
      }
      appliedAttempts += 1
      if (appliedAttempts === 1) {
        throw new Error('DB response lost after commit')
      }
      return {
        kind: 'stateMismatch' as const,
        change: { id: input.id, state: 'applied' } as unknown as ChatNoteChange,
      }
    })
    const setup = options({ setChangeState })

    await expect(
      setup.host.applyChange({
        kind: 'edit',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: BEFORE,
        afterSource: AFTER,
        expectedRevision: await hashContent(BEFORE),
      }),
    ).resolves.toMatchObject({ ok: true, path: 'notes/project.md' })
    expect(setChangeState).toHaveBeenCalledTimes(2)
    expect(setChangeState).not.toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'prepared', state: 'uncertain' }),
    )
  })

  it('does not let recovery claim a current-session prepared row before its write lands', async () => {
    const writeResult = deferred<{ kind: 'written'; revision: string; modifiedMs: number }>()
    const writeStarted = deferred<void>()
    const setup = options({
      pendingChanges: vi.fn(async () => []),
      writeNoteIfRevision: vi.fn(async () => {
        writeStarted.resolve()
        return await writeResult.promise
      }),
    })
    const mutation = setup.host.applyChange({
      kind: 'edit',
      toolCallId: 'tool-1',
      path: 'notes/project.md',
      title: 'Project',
      beforeSource: BEFORE,
      afterSource: AFTER,
      expectedRevision: await hashContent(BEFORE),
    })
    await writeStarted.promise

    const recovery = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })
    await expect(recovery.reconcilePendingChanges()).resolves.toEqual([])
    expect(setup.dependencies.setChangeState).not.toHaveBeenCalled()

    writeResult.resolve({ kind: 'written', revision: await hashContent(AFTER), modifiedMs: 1 })
    await expect(mutation).resolves.toMatchObject({ ok: true, path: 'notes/project.md' })
  })

  it('rechecks privacy before journaling or applying a prepared edit', async () => {
    const privateSource = '---\nprivate: true\n---\n# Project\n\nBefore\n'
    const setup = options()

    await expect(
      setup.host.applyChange({
        kind: 'edit',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: privateSource,
        afterSource: privateSource.replace('Before', 'After'),
        expectedRevision: await hashContent(privateSource),
      }),
    ).resolves.toMatchObject({ ok: false, code: 'private' })
    expect(setup.dependencies.prepareChange).not.toHaveBeenCalled()
    expect(setup.dependencies.writeNoteIfRevision).not.toHaveBeenCalled()
  })

  it('journals a collision-safe create before claiming its path', async () => {
    const setup = options()

    await expect(
      setup.host.createNote({ toolCallId: 'tool-create', title: 'New note' }),
    ).resolves.toMatchObject({
      ok: true,
      changeId: 'change-1',
      path: 'notes/new-note.md',
    })
    expect(setup.events).toEqual(['prepare', 'create'])
    expect(setup.dependencies.prepareChange).toHaveBeenCalledWith({
      change: expect.objectContaining({
        operation: 'create',
        beforeSource: null,
        beforeRevision: null,
      }),
      generation: 9,
    })
  })

  it('keeps live reads available but refuses writes without a durable index session', async () => {
    const setup = options()
    const host = createDesktopChatNoteToolHost({
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      graphGeneration: 7,
      indexGeneration: null,
      dependencies: setup.dependencies,
    })

    await expect(host.readNote('notes/project.md')).resolves.toBe(BEFORE)
    await expect(
      host.applyChange({
        kind: 'edit',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: BEFORE,
        afterSource: AFTER,
        expectedRevision: await hashContent(BEFORE),
      }),
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(setup.dependencies.prepareChange).not.toHaveBeenCalled()
  })

  it('refuses new mutations without sequencing, journaling, or writing after seal', async () => {
    const setup = options()
    setup.host.seal()

    await expect(
      setup.host.applyChange({
        kind: 'edit',
        toolCallId: 'tool-1',
        path: 'notes/project.md',
        title: 'Project',
        beforeSource: BEFORE,
        afterSource: AFTER,
        expectedRevision: await hashContent(BEFORE),
      }),
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    await expect(
      setup.host.createNote({ toolCallId: 'tool-create', title: 'New note' }),
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })

    expect(setup.dependencies.prepareChange).not.toHaveBeenCalled()
    expect(setup.dependencies.writeNoteIfRevision).not.toHaveBeenCalled()
    expect(setup.dependencies.createNote).not.toHaveBeenCalled()
    expect(setup.events).toEqual([])
  })
})

describe('createDesktopChatNoteChangeService', () => {
  it('reconciles a prepared checkpoint whose intended bytes landed', async () => {
    const pending = await change({ state: 'prepared' })
    const setup = options({
      readNote: vi.fn(async () => AFTER),
      pendingChanges: vi.fn(async () => [pending]),
    })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.reconcilePendingChanges()).resolves.toEqual([
      { changeId: 'change-1', path: 'notes/project.md', state: 'applied' },
    ])
    expect(setup.dependencies.setChangeState).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'change-1',
        expectedState: 'prepared',
        state: 'applied',
      }),
    )
  })

  it('promotes an uncertain forward mutation when exact after-bytes are present', async () => {
    const pending = await change({
      state: 'uncertain',
      errorMessage: 'The write response could not be verified.',
    })
    const setup = options({
      readNote: vi.fn(async () => AFTER),
      pendingChanges: vi.fn(async () => [pending]),
    })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.reconcilePendingChanges()).resolves.toEqual([
      { changeId: 'change-1', path: 'notes/project.md', state: 'applied' },
    ])
    expect(setup.dependencies.setChangeState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'uncertain', state: 'applied' }),
    )
  })

  it('retires an uncertain forward mutation when exact before-bytes remain', async () => {
    const pending = await change({
      state: 'uncertain',
      errorMessage: 'The write response could not be verified.',
    })
    const setup = options({
      readNote: vi.fn(async () => BEFORE),
      pendingChanges: vi.fn(async () => [pending]),
    })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.reconcilePendingChanges()).resolves.toEqual([
      { changeId: 'change-1', path: 'notes/project.md', state: 'failed' },
    ])
    expect(setup.dependencies.setChangeState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'uncertain', state: 'failed' }),
    )
  })

  it('reconciles an abandoned undoing checkpoint according to the restored bytes', async () => {
    const pending = await change({ state: 'undoing' })
    const setup = options({
      readNote: vi.fn(async () => BEFORE),
      pendingChanges: vi.fn(async () => [pending]),
    })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.reconcilePendingChanges()).resolves.toEqual([
      { changeId: 'change-1', path: 'notes/project.md', state: 'undone' },
    ])
    expect(setup.dependencies.setChangesStateBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ids: ['change-1'],
        expectedState: 'undoing',
        state: 'undone',
      }),
    )
  })

  it('reconciles an Undo-origin uncertain row in the reverse direction', async () => {
    const pending = await change({
      state: 'uncertain',
      errorMessage: 'Undo outcome uncertain: the guarded response was lost.',
      updatedMs: 2_000,
    })
    const setup = options({
      readNote: vi.fn(async () => BEFORE),
      pendingChanges: vi.fn(async () => [pending]),
    })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.reconcilePendingChanges()).resolves.toEqual([
      { changeId: 'change-1', path: 'notes/project.md', state: 'undone' },
    ])
    expect(setup.dependencies.setChangesStateBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ids: ['change-1'],
        expectedState: 'uncertain',
        state: 'undone',
      }),
    )
    expect(setup.dependencies.setChangeState).not.toHaveBeenCalled()
  })

  it('reconciles every row in a crashed same-path Undo against the group endpoints', async () => {
    const middle = '# Project\n\nMiddle\n'
    const first = await change({
      id: 'change-1',
      state: 'undoing',
      sequence: 0,
      afterSource: middle,
      afterRevision: await hashContent(middle),
      updatedMs: 2_000,
    })
    const second = await change({
      id: 'change-2',
      toolCallId: 'tool-2',
      state: 'undoing',
      sequence: 1,
      beforeSource: middle,
      beforeRevision: await hashContent(middle),
      updatedMs: 2_000,
    })
    const setup = options({
      readNote: vi.fn(async () => BEFORE),
      pendingChanges: vi.fn(async () => [first, second]),
    })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.reconcilePendingChanges()).resolves.toEqual([
      { changeId: 'change-1', path: first.path, state: 'undone' },
      { changeId: 'change-2', path: second.path, state: 'undone' },
    ])
    expect(setup.dependencies.setChangesStateBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ids: ['change-1', 'change-2'],
        expectedState: 'undoing',
        state: 'undone',
      }),
    )
    expect(setup.dependencies.setChangeState).not.toHaveBeenCalled()
  })

  it('restores the first before-state for multiple applied operations on one path', async () => {
    const middle = '# Project\n\nMiddle\n'
    const first = await change({
      id: 'change-1',
      sequence: 0,
      afterSource: middle,
      afterRevision: await hashContent(middle),
    })
    const second = await change({
      id: 'change-2',
      toolCallId: 'tool-2',
      sequence: 1,
      beforeSource: middle,
      beforeRevision: await hashContent(middle),
    })
    const setup = options({ readNote: vi.fn(async () => AFTER) })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.undoPath([first, second], first.path)).resolves.toEqual({
      ok: true,
      undonePaths: ['notes/project.md'],
      failures: [],
    })
    expect(setup.dependencies.writeNoteIfRevision).toHaveBeenCalledWith(
      'notes/project.md',
      BEFORE,
      await hashContent(AFTER),
      7,
    )
    expect(setup.dependencies.setChangesStateBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ids: ['change-1', 'change-2'],
        expectedState: 'applied',
        state: 'undoing',
      }),
    )
    expect(setup.dependencies.setChangesStateBatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ids: ['change-1', 'change-2'],
        expectedState: 'undoing',
        state: 'undone',
      }),
    )
    expect(setup.events).toEqual(['state:applied->undoing', 'write', 'state:undoing->undone'])
  })

  it('preflights every note before whole-turn Undo and changes nothing when one is stale', async () => {
    const first = await change()
    const second = await change({
      id: 'change-2',
      toolCallId: 'tool-2',
      path: 'notes/second.md',
      beforeSource: '# Second\n\nBefore\n',
      afterSource: '# Second\n\nAfter\n',
      beforeRevision: await hashContent('# Second\n\nBefore\n'),
      afterRevision: await hashContent('# Second\n\nAfter\n'),
    })
    const setup = options({
      readNote: vi.fn(async (path: string) =>
        path === 'notes/project.md' ? AFTER : '# Second\n\nChanged again\n',
      ),
    })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.undoTurn([first, second])).resolves.toEqual({
      ok: false,
      undonePaths: [],
      failures: [
        {
          path: 'notes/second.md',
          code: 'stale',
          message: 'The note changed after the AI edit.',
        },
      ],
    })
    expect(setup.dependencies.writeNoteIfRevision).not.toHaveBeenCalled()
    expect(setup.dependencies.trashNoteIfRevision).not.toHaveBeenCalled()
    expect(setup.dependencies.setChangesStateBatch).not.toHaveBeenCalled()
  })

  it('undoes cross-note groups in reverse tool sequence', async () => {
    const first = await change()
    const secondBefore = '# Second\n\nBefore\n'
    const secondAfter = '# Second\n\nAfter\n'
    const second = await change({
      id: 'change-2',
      toolCallId: 'tool-2',
      path: 'notes/second.md',
      sequence: 1,
      beforeSource: secondBefore,
      afterSource: secondAfter,
      beforeRevision: await hashContent(secondBefore),
      afterRevision: await hashContent(secondAfter),
    })
    const writeOrder: string[] = []
    const setup = options({
      readNote: vi.fn(async (path: string) => (path === 'notes/project.md' ? AFTER : secondAfter)),
      writeNoteIfRevision: vi.fn(async (path: string, contents: string) => {
        writeOrder.push(path)
        return {
          kind: 'written' as const,
          revision: await hashContent(contents),
          modifiedMs: 1,
        }
      }),
    })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.undoTurn([first, second])).resolves.toMatchObject({
      ok: true,
      undonePaths: ['notes/second.md', 'notes/project.md'],
    })
    expect(writeOrder).toEqual(['notes/second.md', 'notes/project.md'])
  })

  it.each(['prepared', 'undoing', 'uncertain'] as const)(
    'refuses whole-turn Undo when another path is %s without touching clean applied paths',
    async (state) => {
      const applied = await change()
      const unresolved = await change({
        id: 'change-2',
        toolCallId: 'tool-2',
        path: 'notes/unresolved.md',
        state,
      })
      const setup = options({ readNote: vi.fn(async () => AFTER) })
      const service = createDesktopChatNoteChangeService({
        graphGeneration: 7,
        indexGeneration: 9,
        dependencies: setup.dependencies,
      })

      await expect(service.undoTurn([applied, unresolved])).resolves.toEqual({
        ok: false,
        undonePaths: [],
        failures: [
          {
            path: 'notes/unresolved.md',
            code: 'invalid_state',
            message:
              'This note has an unresolved change and cannot be included in whole-turn Undo.',
          },
        ],
      })
      expect(setup.dependencies.readNote).not.toHaveBeenCalled()
      expect(setup.dependencies.setChangesStateBatch).not.toHaveBeenCalled()
      expect(setup.dependencies.writeNoteIfRevision).not.toHaveBeenCalled()

      await expect(service.undoPath([applied, unresolved], applied.path)).resolves.toMatchObject({
        ok: true,
        undonePaths: [applied.path],
      })
    },
  )

  it('changes no file when another Undo worker wins the atomic journal claim', async () => {
    const applied = await change()
    const setup = options({
      setChangesStateBatch: vi.fn(async () => ({
        kind: 'stateMismatch' as const,
        changes: [{ ...applied, state: 'undoing' as const }],
      })),
    })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.undoPath([applied], applied.path)).resolves.toEqual({
      ok: false,
      undonePaths: [],
      failures: [
        {
          path: applied.path,
          code: 'invalid_state',
          message: 'This change is already being handled or is no longer applied.',
        },
      ],
    })
    expect(setup.dependencies.writeNoteIfRevision).not.toHaveBeenCalled()
    expect(setup.dependencies.trashNoteIfRevision).not.toHaveBeenCalled()
  })

  it('moves a contended Undo claim to uncertain and reports the exact path outcome', async () => {
    const applied = await change()
    const setup = options({
      writeNoteIfRevision: vi.fn(async () => ({
        kind: 'contended' as const,
        currentRevision: null,
      })),
    })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.undoPath([applied], applied.path)).resolves.toEqual({
      ok: false,
      undonePaths: [],
      failures: [
        {
          path: applied.path,
          code: 'contended',
          message: 'The note changed while Undo was being verified; its outcome is uncertain.',
        },
      ],
    })
    expect(setup.dependencies.setChangesStateBatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedState: 'undoing',
        state: 'uncertain',
        errorMessage: expect.stringMatching(/^Undo outcome uncertain:/),
      }),
    )
  })

  it('conditionally trashes an unchanged created note and discards its open session', async () => {
    const createdSource = '# New note\n'
    const created = await change({
      operation: 'create',
      path: 'notes/new-note.md',
      beforeSource: null,
      beforeRevision: null,
      afterSource: createdSource,
      afterRevision: await hashContent(createdSource),
    })
    const discard = vi.fn()
    const session = {
      readFreshContent: vi.fn(async () => ({
        source: createdSource,
        revision: await hashContent(createdSource),
      })),
      commitConditionalTrash: vi.fn(async (options: NoteConditionalTrashOptions) => {
        const outcome = await options.trash(options.expectedRevision)
        if (outcome.kind === 'trashed') {
          discard()
        }
        return outcome
      }),
      discard,
    } as unknown as NoteSession
    const setup = options({ lookupSession: () => session })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.undoPath([created], created.path)).resolves.toMatchObject({ ok: true })
    expect(setup.dependencies.trashNoteIfRevision).toHaveBeenCalledWith(
      created.path,
      created.afterRevision,
      7,
      undefined,
    )
    expect(discard).toHaveBeenCalledOnce()
  })

  it('does not fall back to disk when an open-session Undo loses its persisted CAS', async () => {
    const session = {
      commitBodyMutation: vi.fn(async () => ({
        status: 'stale' as const,
        currentRevision: 'external-revision',
      })),
    } as unknown as NoteSession
    const setup = options({ lookupSession: () => session })
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })
    const applied = await change()

    await expect(service.undoPath([applied], applied.path)).resolves.toEqual({
      ok: false,
      undonePaths: [],
      failures: [
        {
          path: applied.path,
          code: 'stale',
          message: 'The note changed after the AI edit.',
        },
      ],
    })
    expect(session.commitBodyMutation).toHaveBeenCalledOnce()
    expect(setup.dependencies.writeNoteIfRevision).not.toHaveBeenCalled()
  })

  it('treats repeated Undo of an already-undone change as an idempotent success', async () => {
    const undone = await change({ state: 'undone' })
    const setup = options()
    const service = createDesktopChatNoteChangeService({
      graphGeneration: 7,
      indexGeneration: 9,
      dependencies: setup.dependencies,
    })

    await expect(service.undoPath([undone], undone.path)).resolves.toEqual({
      ok: true,
      undonePaths: [],
      failures: [],
    })
    await expect(service.undoTurn([undone])).resolves.toEqual({
      ok: true,
      undonePaths: [],
      failures: [],
    })
    expect(setup.dependencies.writeNoteIfRevision).not.toHaveBeenCalled()
    expect(setup.dependencies.trashNoteIfRevision).not.toHaveBeenCalled()
  })
})
