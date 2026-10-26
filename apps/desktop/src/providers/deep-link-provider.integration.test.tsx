import { describe, expect, it, vi } from 'vitest'
import { createTestAppServices } from '@reflect/app/testing'
import {
  createTestCoreServices,
  createTestCaptureInboxService,
  createTestDeepLinkIntakeService,
  createTestGraphSessionService,
} from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { DeepLinkProvider } from './deep-link-provider.tsx'

describe('DeepLinkProvider navigation intent integration', () => {
  it('keeps a deferred note resolution current when a capture arrives', async () => {
    const pendingResolution = Promise.withResolvers<string>()
    const { indexQuery } = createTestCoreServices({ database: createWasmTestDatabaseService() })
    const resolveNoteTarget = vi
      .spyOn(indexQuery, 'resolveNoteTarget')
      .mockImplementation(() => pendingResolution.promise)
    const captureInbox = createTestCaptureInboxService()
    const graphSession = createTestGraphSessionService()
    const core = createTestCoreServices({
      database: createWasmTestDatabaseService(),
      captureInbox,
      graphSession,
      deepLinkIntake: createTestDeepLinkIntakeService({
        indexQuery,
        captureInbox,
        graphSession,
      }),
    })
    const appServices = createTestAppServices(core)
    await renderInApp(<DeepLinkProvider>{null}</DeepLinkProvider>, { core, appServices })

    appServices.deepLinkRouter.dispatch('reflect://note/Project%20X')
    expect(resolveNoteTarget).toHaveBeenCalledWith('Project X')

    appServices.deepLinkRouter.dispatch('reflect://append?text=captured%20while%20resolving')
    await vi.waitFor(() => expect(core.captureInbox.spooled()).toHaveLength(1))

    pendingResolution.resolve('notes/project-x.md')

    await vi.waitFor(() => {
      expect(appServices.navigation.navigations().map((call) => call.route)).toEqual([
        { kind: 'note', path: 'notes/project-x.md' },
      ])
    })
  })
})
