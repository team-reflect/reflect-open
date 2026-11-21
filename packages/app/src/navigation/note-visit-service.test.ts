import { afterEach, describe, expect, it } from 'vitest'
import {
  createTestClockService,
  createTestDatabaseService,
  createTestGraphSessionService,
  createTestIpcBridgeService,
  createTestLoggerService,
  seedNotes,
  type TestDatabaseService,
} from '@reflect/core/testing'
import { createTestNavigationService } from '../testing/navigation.ts'
import { createNoteVisitService } from './note-visit-service.ts'

let database: TestDatabaseService

afterEach(() => {
  database.close()
})

function setup(indexOpen = true) {
  database = createTestDatabaseService()
  seedNotes(database, [
    { path: 'notes/a.md', markdown: '# A\n' },
    { path: 'notes/b.md', markdown: '# B\n' },
  ])
  const navigation = createTestNavigationService()
  const graphSession = createTestGraphSessionService()
  graphSession.adopt(
    { root: '/graph', name: 'graph', generation: 1 },
    indexOpen ? database.generation() : null,
  )
  const ipc = createTestIpcBridgeService({
    commands: {
      note_visit_record: (args) => {
        return database.invoke('note_visit_record', args as never)
      },
    },
  })
  const clock = createTestClockService({ now: 1000 })
  const service = createNoteVisitService({
    navigation,
    graphSession,
    ipc,
    clock,
    logger: createTestLoggerService(),
  })
  const recorded = () => {
    return ipc
      .calls()
      .filter((call) => call.command === 'note_visit_record')
      .map((call) => (call.args as { path: string }).path)
  }
  return { navigation, graphSession, clock, service, recorded }
}

describe('NoteVisitService', () => {
  it('records the note on screen and each later arrival, including back', () => {
    const { navigation, service, recorded } = setup()
    navigation.reset({ kind: 'note', path: 'notes/a.md' })
    service.track()
    navigation.navigate({ kind: 'note', path: 'notes/b.md' })
    navigation.back()
    expect(recorded()).toEqual(['notes/a.md', 'notes/b.md', 'notes/a.md'])
  })

  it('does not record a rename of the note on screen', () => {
    const { navigation, service, recorded } = setup()
    service.track()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    navigation.noteMoved('notes/a.md', 'notes/b.md')
    expect(recorded()).toEqual(['notes/a.md'])
  })

  it('records the first arrival of a fresh history', () => {
    const { navigation, service, recorded } = setup()
    const untrack = service.track()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    untrack()
    navigation.reset()
    service.track()
    navigation.navigate({ kind: 'note', path: 'notes/b.md' })
    expect(recorded()).toEqual(['notes/a.md', 'notes/b.md'])
  })

  it('records an arrival without an index once the index opens', () => {
    const { navigation, graphSession, service, recorded } = setup(false)
    service.track()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    expect(recorded()).toEqual([])
    graphSession.setState({ indexGeneration: database.generation() })
    expect(recorded()).toEqual(['notes/a.md'])
  })

  it('writes the visits to the index, most recent first', async () => {
    const { navigation, clock, service } = setup()
    service.track()
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    clock.setNow(2000)
    navigation.navigate({ kind: 'note', path: 'notes/b.md' })
    await Promise.resolve()
    await expect(database.read('index_visited_notes', { limit: 8 })).resolves.toEqual([
      { path: 'notes/b.md', title: 'B' },
      { path: 'notes/a.md', title: 'A' },
    ])
  })
})
