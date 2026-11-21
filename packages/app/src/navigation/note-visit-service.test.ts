import { describe, expect, it } from 'vitest'
import {
  createTestClockService,
  createTestGraphSessionService,
  createTestIpcBridgeService,
  createTestLoggerService,
} from '@reflect/core/testing'
import { returnNull } from '@ocavue/utils'
import { createTestNavigationService } from '../testing/navigation.ts'
import { createNoteVisitService } from './note-visit-service.ts'

function setup(indexGeneration: number | null = 7) {
  const navigation = createTestNavigationService()
  const graphSession = createTestGraphSessionService()
  graphSession.adopt({ root: '/graph', name: 'graph', generation: 1 }, indexGeneration)
  const ipc = createTestIpcBridgeService({
    commands: {
      note_visit_record: returnNull,
    },
  })
  const noteList = {
    listVisitedNotes: () => {
      return Promise.resolve([
        { path: 'notes/a.md', title: 'A' },
        { path: 'notes/b.md', title: 'B' },
      ])
    },
  }
  const service = createNoteVisitService({
    navigation,
    graphSession,
    ipc,
    noteList,
    clock: createTestClockService({ now: 1000 }),
    logger: createTestLoggerService(),
  })
  const recorded = () => {
    return ipc
      .calls()
      .filter((call) => call.command === 'note_visit_record')
      .map((call) => call.args)
  }
  return { navigation, ipc, service, recorded }
}

describe('NoteVisitService', () => {
  it('records each arrival on a note route', () => {
    const { navigation, recorded } = setup()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    navigation.navigate({ kind: 'today' })
    navigation.back()
    expect(recorded()).toEqual([
      { path: 'notes/a.md', visitedMs: 1000, generation: 7 },
      { path: 'notes/a.md', visitedMs: 1000, generation: 7 },
    ])
  })

  it('does not record a rename of the note on screen', () => {
    const { navigation, recorded } = setup()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    navigation.noteMoved('notes/a.md', 'notes/b.md')
    expect(recorded()).toHaveLength(1)
  })

  it('records nothing while no index is open', () => {
    const { navigation, recorded } = setup(null)
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    expect(recorded()).toEqual([])
  })

  it('lists the recent notes without the note on screen', async () => {
    const { navigation, service } = setup()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    await expect(service.listRecent(8)).resolves.toEqual([{ path: 'notes/b.md', title: 'B' }])
  })
})
