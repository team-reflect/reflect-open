import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestCoreServices,
  createTestDatabaseService,
  type TestCoreServices,
} from '@reflect/core/testing'
import { createTestAppServices, type TestAppServices } from '../testing/services.ts'
import { switchToRecentGraph } from './graph-switch.ts'

let core: TestCoreServices
let appLayer: TestAppServices

beforeEach(() => {
  core = createTestCoreServices({ database: createTestDatabaseService() })
  appLayer = createTestAppServices(core)
})

afterEach(() => {
  core.database.close()
})

describe('switchToRecentGraph', () => {
  it('opens the recent graph at the position, unless it is the open one', async () => {
    core.graphSession.setGraph({ root: '/g' })
    core.graphSession.setState({
      recents: [
        { root: '/g', name: 'g', openedMs: 2 },
        { root: '/work', name: 'Work', openedMs: 1 },
      ],
    })
    const openRecent = vi.spyOn(appLayer.graphBoot, 'openRecent').mockResolvedValue(true)

    await switchToRecentGraph(core.graphSession, appLayer.graphBoot, 1)
    await switchToRecentGraph(core.graphSession, appLayer.graphBoot, 3)
    await switchToRecentGraph(core.graphSession, appLayer.graphBoot, 2)

    expect(openRecent.mock.calls).toEqual([['/work']])
  })
})
