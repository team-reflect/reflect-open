import { formatIsoDate } from '@reflect/utils'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { describe, expect, it, vi } from 'vitest'
import type { XPostEnvelope } from './bookmark-envelope.ts'
import type { TextCaptureEnvelope } from './capture-envelope.ts'
import { captureIdentity } from './capture-identity.ts'
import { captureNoteSource } from './capture-note.ts'
import { createBackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import { AppError } from '../errors.ts'
import { createAiCredentialService } from '../ai/ai-credential-service.ts'
import { createAiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import { createOpenDocumentsService } from '../documents/open-documents-service.ts'
import { dailyPath } from '../graph/paths.ts'
import { createPrivacyService } from '../privacy/privacy-service.ts'
import {
  createTestAiKeyValidationService,
  createTestAssetStoreService,
  createTestCaptureInboxService,
  createTestClockService,
  createTestFileChangeService,
  createTestIdService,
  createTestActivityPort,
  createTestLoggerService,
  createTestNoteFileService,
  createTestNoteSession,
  createTestProgressPort,
  createTestPageDescriberService,
  createTestPlatformService,
  createTestSecretStoreService,
  createTestSettingsService,
  createTestWebFetchService,
  createTestXArchiveService,
} from '../testing/index.ts'
import { createCaptureService } from './capture-service.ts'

const CAPTURED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
const DAILY = dailyPath(formatIsoDate(CAPTURED_AT))

const TEXT: TextCaptureEnvelope = {
  version: 1,
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  kind: 'append',
  text: 'call the bank',
  capturedAt: CAPTURED_AT.toISOString(),
  source: 'deep-link',
}

const X_POST: XPostEnvelope = {
  version: 2,
  kind: 'x-bookmark',
  postId: '20',
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  source: 'extension',
  capturedAt: CAPTURED_AT.toISOString(),
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function setup(options: { mobile?: boolean } = {}) {
  const noteFile = createTestNoteFileService()
  const captureInbox = createTestCaptureInboxService()
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  const activity = createTestActivityPort()
  const fileChanges = createTestFileChangeService()
  const progress = createTestProgressPort()
  const logger = createTestLoggerService()
  const capture = createCaptureService({
    captureInbox,
    noteFile,
    assetStore: createTestAssetStoreService(),
    openDocuments,
    backlinkTarget: { ensure: (title) => title },
    xArchive: createTestXArchiveService(),
    webFetch: createTestWebFetchService(),
    pageDescriber: createTestPageDescriberService(),
    aiProviderConfig: createAiProviderConfigService({
      settings: createTestSettingsService(),
      credentials: createAiCredentialService({ secretStore: createTestSecretStoreService() }),
      keyValidation: createTestAiKeyValidationService(),
      id: createTestIdService(),
    }),
    aiCredentials: createAiCredentialService({ secretStore: createTestSecretStoreService() }),
    privacy: createPrivacyService({
      noteFile,
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
    }),
    clock: createTestClockService(),
    reconcilers: createBackgroundReconcilerFactory({ activity }),
    activity,
    fileChanges,
    progress,
    platform: createTestPlatformService({ surface: { mobileApp: options.mobile ?? false } }),
    logger,
  })
  return {
    capture,
    noteFile,
    captureInbox,
    openDocuments,
    activity,
    fileChanges,
    progress,
    logger,
    /**
     * One call per drain phase.
     */
    drains: vi.spyOn(captureInbox, 'list'),
    /**
     * Two calls per pass: the enrichment phase and the link repair sweep.
     */
    enrichments: vi.spyOn(noteFile, 'listNotes'),
    relays: vi.spyOn(captureInbox, 'relaySharedInbox'),
  }
}

describe('CaptureService (host registration)', () => {
  it('registers the host BEFORE the first drain pass', async () => {
    const kit = setup()
    // Park registration: the session must not drain while the pointer file
    // may still name the previous graph.
    const pendingRegistration = Promise.withResolvers<void>()
    const registerHost = vi
      .spyOn(kit.captureInbox, 'registerHost')
      .mockImplementation(() => pendingRegistration.promise)

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()
    expect(registerHost).toHaveBeenCalledTimes(1)
    expect(kit.drains).not.toHaveBeenCalled()

    pendingRegistration.resolve()
    await flush()
    expect(kit.drains).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('still starts the drain when registration fails — spooled captures must land', async () => {
    const kit = setup()
    vi.spyOn(kit.captureInbox, 'registerHost').mockRejectedValue(
      new Error('manifest dir unwritable'),
    )

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()

    expect(kit.drains).toHaveBeenCalledTimes(1)
    expect(kit.logger.getErrors().map((entry) => entry.message)).toEqual([
      'capture host registration failed:',
    ])
    session.dispose()
  })

  it('never drains a session disposed while registering', async () => {
    const kit = setup()
    const pendingRegistration = Promise.withResolvers<void>()
    vi.spyOn(kit.captureInbox, 'registerHost').mockImplementation(() => pendingRegistration.promise)

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    session.dispose()
    pendingRegistration.resolve()
    await flush()

    expect(kit.drains).not.toHaveBeenCalled()
    expect(kit.fileChanges.listenerCount().changes).toBe(0)
  })

  it('on mobile, skips host registration', async () => {
    const kit = setup({ mobile: true })

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()

    expect(kit.captureInbox.hostRegistrations()).toBe(0)
    expect(kit.drains).toHaveBeenCalledTimes(1)
    session.dispose()
  })
})

describe('CaptureService (shared-inbox relay)', () => {
  it('relays the shared inbox BEFORE the drain, every pass', async () => {
    const kit = setup({ mobile: true })
    const order: string[] = []
    kit.relays.mockImplementation(() => {
      order.push('relay')
      return Promise.resolve(1)
    })
    kit.drains.mockImplementation(() => {
      order.push('drain')
      return Promise.resolve([])
    })

    const session = kit.capture.openSession({ generation: 7 })
    session.start()
    await flush()

    expect(order).toEqual(['relay', 'drain'])
    expect(kit.relays).toHaveBeenCalledWith(7)

    session.schedule()
    await flush()
    expect(order).toEqual(['relay', 'drain', 'relay', 'drain'])
    session.dispose()
  })

  it('still drains when the relay fails, surfacing the failure once', async () => {
    const kit = setup({ mobile: true })
    kit.relays.mockRejectedValue(new Error('container gone'))

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()

    expect(kit.drains).toHaveBeenCalledTimes(1)
    expect(kit.progress.snapshot()).toEqual([
      expect.objectContaining({
        label: 'Saving shared capture',
        status: 'failed',
        message: 'container gone',
      }),
    ])

    // The same failure on a retry pass must not re-toast.
    session.schedule()
    await flush()
    expect(kit.drains).toHaveBeenCalledTimes(2)
    expect(kit.progress.getAll()).toHaveLength(1)
    session.dispose()
  })

  it('on desktop, passes run drain-then-enrich only', async () => {
    const kit = setup()

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()

    expect(kit.relays).not.toHaveBeenCalled()
    expect(kit.drains).toHaveBeenCalledTimes(1)
    expect(kit.enrichments).toHaveBeenCalledTimes(2)
    expect(kit.progress.getAll()).toEqual([])
    session.dispose()
  })

  it('schedules a pass when the app becomes visible again (mobile resume)', async () => {
    const kit = setup({ mobile: true })
    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()
    expect(kit.drains).toHaveBeenCalledTimes(1)

    kit.activity.emitVisible()
    await flush()

    expect(kit.drains).toHaveBeenCalledTimes(2)
    session.dispose()
  })

  it('does not listen for visibility on desktop', async () => {
    const kit = setup()
    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()
    expect(kit.drains).toHaveBeenCalledTimes(1)

    kit.activity.emitVisible()
    await flush()

    expect(kit.drains).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('stops listening for visibility after dispose', async () => {
    const kit = setup({ mobile: true })
    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()
    session.dispose()

    kit.activity.emitVisible()
    await flush()

    expect(kit.drains).toHaveBeenCalledTimes(1)
  })
})

describe('CaptureService (triggers)', () => {
  it('schedules a pass when a capture is spooled, and ignores other files', async () => {
    const kit = setup()
    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()
    expect(kit.drains).toHaveBeenCalledTimes(1)

    kit.fileChanges.emit({
      changes: [{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1 }],
      source: 'external',
    })
    kit.fileChanges.emit({
      changes: [{ path: '.reflect/inbox/a.json', kind: 'remove' }],
      source: 'external',
    })
    await flush()
    expect(kit.drains).toHaveBeenCalledTimes(1)

    kit.fileChanges.emit({
      changes: [{ path: '.reflect/inbox/a.json', kind: 'upsert', modifiedMs: 1 }],
      source: 'external',
    })
    await flush()
    expect(kit.drains).toHaveBeenCalledTimes(2)

    session.dispose()
    expect(kit.fileChanges.listenerCount().changes).toBe(0)
  })

  describe('placeholder capture links', () => {
    const identity = captureIdentity(CAPTURED_AT, '7c9e6679-7425-40de-944b-e07fc1f90ae7')
    const placeholderDaily = `## [[Links]]\n\n- [[${identity.base}|example.com]]\n`
    const titledDaily = `## [[Links]]\n\n- [[${identity.base}|A Cleaned Up Article]]\n`

    async function finishedCapture(): Promise<string> {
      return await captureNoteSource(
        {
          version: 1,
          id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          url: 'https://example.com/article',
          title: 'A Cleaned Up Article',
          capturedAt: CAPTURED_AT.toISOString(),
          source: 'ios-share',
        },
        identity,
        { hasScreenshot: false, status: 'done' },
      )
    }

    it('repairs existing placeholder links on launch', async () => {
      const kit = setup()
      kit.noteFile.set(identity.notePath, await finishedCapture())
      kit.noteFile.set(DAILY, placeholderDaily)

      const session = kit.capture.openSession({ generation: 3 })
      session.start()

      await vi.waitFor(() => {
        expect(kit.noteFile.files().get(DAILY)).toBe(titledDaily)
      })
      session.dispose()
    })

    it('repairs on the next pass when the daily arrived before the finished capture', async () => {
      const kit = setup()
      kit.noteFile.set(DAILY, placeholderDaily)
      const session = kit.capture.openSession({ generation: 3 })
      session.start()
      await vi.waitFor(() => {
        expect(kit.enrichments).toHaveBeenCalledTimes(2)
      })
      await flush()
      expect(kit.noteFile.files().get(DAILY)).toBe(placeholderDaily)

      kit.noteFile.set(identity.notePath, await finishedCapture())
      kit.activity.emitWake()

      await vi.waitFor(() => {
        expect(kit.noteFile.files().get(DAILY)).toBe(titledDaily)
      })
      session.dispose()
    })
  })

  it('retries on wake', async () => {
    const kit = setup()
    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()

    kit.activity.emitWake()
    await flush()

    expect(kit.drains).toHaveBeenCalledTimes(2)
    session.dispose()
  })

  it('lands a spooled text capture in the daily note of the session generation', async () => {
    const kit = setup()
    kit.captureInbox.add(`${TEXT.id}.json`, TEXT)

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()

    expect(kit.noteFile.writes()).toEqual([
      { path: DAILY, contents: '- call the bank\n', generation: 3 },
    ])
    expect(kit.captureInbox.files().size).toBe(0)
    session.dispose()
  })

  it('surfaces a drain failure once, then lands the capture when the failure clears', async () => {
    const kit = setup()
    kit.captureInbox.add(`${TEXT.id}.json`, TEXT)
    const write = vi.spyOn(kit.noteFile, 'write').mockRejectedValue(new AppError('io', 'disk full'))

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()
    session.schedule()
    await flush()

    expect(kit.progress.snapshot()).toEqual([
      expect.objectContaining({
        label: 'Saving link capture',
        status: 'failed',
        message: 'disk full',
      }),
    ])

    write.mockRestore()
    session.schedule()
    await flush()
    expect(kit.noteFile.files().get(DAILY)).toBe('- call the bank\n')
    session.dispose()
  })
})

describe('CaptureService (X posts)', () => {
  it('reports X post writes after a pass drains captures', async () => {
    const kit = setup()
    kit.captureInbox.add(`${TEXT.id}.json`, TEXT)
    const written = vi.fn()
    kit.capture.onXPostsWritten(written)

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()

    expect(written).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('reports X post writes after a pass stops partway', async () => {
    const kit = setup()
    kit.captureInbox.add(`${TEXT.id}.json`, TEXT)
    vi.spyOn(kit.noteFile, 'write').mockRejectedValue(new AppError('io', 'disk full'))
    const written = vi.fn()
    kit.capture.onXPostsWritten(written)

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()

    expect(written).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('reports nothing after a pass with nothing to drain, or once unsubscribed', async () => {
    const kit = setup()
    const written = vi.fn()
    const stop = kit.capture.onXPostsWritten(written)

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()
    expect(written).not.toHaveBeenCalled()

    stop()
    kit.captureInbox.add(`${TEXT.id}.json`, TEXT)
    session.schedule()
    await flush()
    expect(written).not.toHaveBeenCalled()
    session.dispose()
  })

  it('appends an X post to the daily note on disk when no document is open', async () => {
    const kit = setup()
    kit.noteFile.set(DAILY, 'My journal\n')
    kit.captureInbox.add(`${X_POST.id}.json`, X_POST)

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()

    expect(kit.noteFile.files().get(DAILY)).toBe(
      'My journal\n\n## X bookmarks\n\n![](https://x.com/i/status/20)\n',
    )
    expect(kit.captureInbox.files().size).toBe(0)
    session.dispose()
  })

  it('creates the daily note for an X post when it does not exist yet', async () => {
    const kit = setup()
    kit.captureInbox.add(`${X_POST.id}.json`, X_POST)

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()

    expect(kit.noteFile.files().get(DAILY)).toBe(
      '## X bookmarks\n\n![](https://x.com/i/status/20)\n',
    )
    session.dispose()
  })

  it('routes an X post through the open daily document', async () => {
    const kit = setup()
    const daily = createTestNoteSession({ path: DAILY, content: 'Unsaved draft\n' })
    kit.openDocuments.register({ session: daily })
    kit.captureInbox.add(`${X_POST.id}.json`, X_POST)

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()

    expect(daily.content()).toBe(
      'Unsaved draft\n\n## X bookmarks\n\n![](https://x.com/i/status/20)\n',
    )
    expect(kit.noteFile.writes()).toEqual([])
    expect(kit.captureInbox.files().size).toBe(0)
    session.dispose()
  })

  it('keeps the X post queued while the open daily document cannot take it', async () => {
    const kit = setup()
    kit.openDocuments.register({
      session: createTestNoteSession({ path: DAILY, accepts: false }),
    })
    kit.captureInbox.add(`${X_POST.id}.json`, X_POST)

    const session = kit.capture.openSession({ generation: 3 })
    session.start()
    await flush()

    expect(kit.captureInbox.files().has(`${X_POST.id}.json`)).toBe(true)
    expect(kit.noteFile.writes()).toEqual([])
    expect(kit.progress.snapshot()).toEqual([
      expect.objectContaining({
        label: 'Saving link capture',
        message: 'Resolve or finish loading the daily note before saving X posts',
      }),
    ])
    session.dispose()
  })
})
