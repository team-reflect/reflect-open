import { describe, expect, it } from 'vitest'
import { createTestClockService } from '../testing/clock.ts'
import { createNodeTestDatabaseService, seedNotes } from '../testing/database.ts'
import { createTestActivityPort } from '../testing/shell.ts'
import { createDailyNoteService, type DailyNoteService } from './daily-note-service.ts'

function createTestDailyNoteService(
  deps?: Partial<Parameters<typeof createDailyNoteService>[0]>,
): DailyNoteService {
  return createDailyNoteService({
    database: deps?.database ?? createNodeTestDatabaseService(),
    clock: deps?.clock ?? createTestClockService(),
    activity: deps?.activity ?? createTestActivityPort(),
  })
}

describe('today', () => {
  it('follows the clock', () => {
    const clock = createTestClockService({ today: '2026-06-12' })
    const dailyNotes = createTestDailyNoteService({ clock })
    expect(dailyNotes.today()).toBe('2026-06-12')
    clock.setToday('2026-06-13')
    expect(dailyNotes.today()).toBe('2026-06-13')
  })
})

describe('dailyDatesInRange', () => {
  it('lists the dates with content within inclusive bounds', async () => {
    const database = createNodeTestDatabaseService()
    seedNotes(database, [
      { path: 'daily/2026-05-31.md', markdown: 'Before\n' },
      { path: 'daily/2026-06-01.md', markdown: 'Bought milk\n' },
      { path: 'daily/2026-06-09.md', markdown: 'Standup\n' },
      { path: 'daily/2026-06-15.md', markdown: '\n' },
      { path: 'daily/2026-06-30.md', markdown: 'Last day\n' },
      { path: 'daily/2026-07-01.md', markdown: 'After\n' },
    ])
    const dailyNotes = createTestDailyNoteService({ database })

    await expect(dailyNotes.dailyDatesInRange('2026-06-01', '2026-06-30')).resolves.toEqual([
      '2026-06-01',
      '2026-06-09',
      '2026-06-30',
    ])
  })

  it('returns an empty list when no daily notes exist in the range', async () => {
    const database = createNodeTestDatabaseService()
    seedNotes(database, [{ path: 'daily/2026-06-01.md', markdown: 'Bought milk\n' }])
    const dailyNotes = createTestDailyNoteService({ database })
    await expect(dailyNotes.dailyDatesInRange('2025-01-01', '2025-01-31')).resolves.toEqual([])
  })
})

describe('listDailyNotes', () => {
  it('selects public dailies in the inclusive range, most recent first, capped', async () => {
    const database = createNodeTestDatabaseService()
    seedNotes(database, [
      { path: 'daily/2026-06-01.md', markdown: 'Older.\n', mtime: 1000 },
      { path: 'daily/2026-06-09.md', markdown: 'Stand-up notes.\n', mtime: 2000 },
      { path: 'daily/2026-06-10.md', markdown: '---\nprivate: true\n---\nSecret.\n' },
      { path: 'daily/2026-07-01.md', markdown: 'Out of range.\n' },
      { path: 'notes/a.md', markdown: '# A\n' },
    ])
    const dailyNotes = createTestDailyNoteService({ database })

    await expect(
      dailyNotes.listDailyNotes({ start: '2026-06-01', end: '2026-06-30', limit: 1 }),
    ).resolves.toEqual([
      {
        path: 'daily/2026-06-09.md',
        title: '2026-06-09',
        dailyDate: '2026-06-09',
        preview: 'Stand-up notes.',
        mtime: 2000,
        isPrivate: false,
      },
    ])
    await expect(
      dailyNotes.listDailyNotes({ start: '2026-06-01', end: '2026-06-30', limit: 32 }),
    ).resolves.toMatchObject([{ path: 'daily/2026-06-09.md' }, { path: 'daily/2026-06-01.md' }])
  })

  it('returns an empty list when no daily notes exist in the range', async () => {
    const database = createNodeTestDatabaseService()
    seedNotes(database, [{ path: 'daily/2026-06-01.md', markdown: 'Older.\n' }])
    const dailyNotes = createTestDailyNoteService({ database })
    await expect(
      dailyNotes.listDailyNotes({ start: '2025-01-01', end: '2025-01-31', limit: 32 }),
    ).resolves.toEqual([])
  })
})

describe('subscribeWakeOnNewDay', () => {
  /**
   * 2026-06-12, late evening.
   */
  const evening = new Date(2026, 5, 12, 22, 0, 0).getTime()

  function setup() {
    const clock = createTestClockService({ now: evening })
    const activity = createTestActivityPort()
    const dailyNotes = createTestDailyNoteService({ clock, activity })
    const days: string[] = []
    const unsubscribe = dailyNotes.subscribeWakeOnNewDay((today) => {
      days.push(today)
    })
    return { clock, activity, days, unsubscribe }
  }

  it('reports today when the app foregrounds on a new date', () => {
    const { clock, activity, days } = setup()
    activity.emitHidden()
    clock.setNow(new Date(2026, 5, 13, 8, 0, 0).getTime())
    activity.emitVisible()
    expect(days).toEqual(['2026-06-13'])
  })

  it('stays quiet when the app foregrounds on the same date', () => {
    const { clock, activity, days } = setup()
    activity.emitHidden()
    clock.setNow(new Date(2026, 5, 12, 23, 30, 0).getTime())
    activity.emitVisible()
    expect(days).toEqual([])
  })

  it('counts from the date the app was hidden on, not the date it subscribed on', () => {
    const { clock, activity, days } = setup()
    // Left open across midnight: the clock's own rollover covers this day.
    clock.setNow(new Date(2026, 5, 13, 8, 0, 0).getTime())
    activity.emitHidden()
    activity.emitVisible()
    expect(days).toEqual([])
  })

  it('reports each new day once', () => {
    const { clock, activity, days } = setup()
    activity.emitHidden()
    clock.setNow(new Date(2026, 5, 13, 8, 0, 0).getTime())
    activity.emitVisible()
    activity.emitVisible()
    expect(days).toEqual(['2026-06-13'])
  })

  it('reads the wall clock, so a stale cached `today()` cannot hide the new day', () => {
    const clock = createTestClockService({ now: evening, today: '2026-06-12' })
    const activity = createTestActivityPort()
    const dailyNotes = createTestDailyNoteService({ clock, activity })
    const days: string[] = []
    dailyNotes.subscribeWakeOnNewDay((today) => {
      days.push(today)
    })
    activity.emitHidden()
    clock.setNow(new Date(2026, 5, 13, 8, 0, 0).getTime())
    activity.emitVisible()
    expect(days).toEqual(['2026-06-13'])
  })

  it('stops after unsubscribing', () => {
    const { clock, activity, days, unsubscribe } = setup()
    unsubscribe()
    activity.emitHidden()
    clock.setNow(new Date(2026, 5, 13, 8, 0, 0).getTime())
    activity.emitVisible()
    expect(days).toEqual([])
  })
})
