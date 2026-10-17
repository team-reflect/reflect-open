import { sha256Hex } from '@reflect/utils'
import { describe, expect, it, vi } from 'vitest'
import { AssetDescriptionRejectedError } from '../ai/asset-describer-service.ts'
import { createBackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import { AppError } from '../errors.ts'
import { descriptionPathFor } from '../graph/paths.ts'
import type { FileChange } from '../indexing/file-change-service.ts'
import type { IndexAppliedEvent } from '../indexing/index-lifecycle-service.ts'
import type { SecretStoreService } from '../secrets/secret-store-service.ts'
import type { AiProviderConfig } from '../settings/schema.ts'
import {
  createTestAssetDescriberService,
  createTestAssetReferences,
  createTestAssetStoreService,
  createTestClockService,
  createTestGraphSessionService,
  createTestActivityPort,
  createTestAiKeyValidationService,
  createTestIdService,
  createTestIndexLifecycleService,
  createTestLoggerService,
  createTestNoteFileService,
  createTestProgressPort,
  createTestSecretStoreService,
  createTestSettingsService,
  createTestXArchiveService,
} from '../testing/index.ts'
import { createAiCredentialService } from '../ai/ai-credential-service.ts'
import { createAiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import { createAssetPrivacyService } from './asset-privacy-service.ts'
import {
  assetTypeFor,
  buildDescriptionSource,
  isEligibleAssetPath,
  readManagedDescription,
} from './asset-description-helpers.ts'
import {
  createAssetDescriptionService,
  type ReconcileAssetDescriptionsInput,
} from './asset-description-service.ts'

const PROVIDER: AiProviderConfig = {
  id: 'cfg-anthropic',
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  keyHint: 'wxyz1',
}

const GENERATION = 7
const INDEX_GENERATION = 11
const NOW = Date.parse('2026-06-16T00:00:00.000Z')

/**
 * A public note referencing `assetPath`.
 */
function publicNote(assetPath: string): string {
  return `# Diagram\n\n![](${assetPath})\n`
}

/**
 * A private note referencing `assetPath`.
 */
function privateNote(assetPath: string): string {
  return `---\nprivate: true\n---\n\n![](${assetPath})\n`
}

function upsert(path: string): FileChange {
  return { path, kind: 'upsert', modifiedMs: 1 }
}

/**
 * Give the work in flight several timer turns. A pass hashes through WebCrypto,
 * which resolves off the timer queue, so one turn is not enough. Use it only
 * before asserting that nothing happened; wait for an outcome with `vi.waitFor`.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * The service over test doubles: an in-memory graph (notes and descriptions
 * in `files`, asset bytes added with `addAsset`), the index references in
 * `refs`, one configured provider with its key, and a describer that answers
 * "A flow diagram.".
 */
function setup(options?: { provider?: AiProviderConfig | null; secretStore?: SecretStoreService }) {
  const files = createTestNoteFileService()
  const assetStore = createTestAssetStoreService()
  const refs = createTestAssetReferences()
  const describer = createTestAssetDescriberService('A flow diagram.')
  const activity = createTestActivityPort()
  const clock = createTestClockService({ now: NOW })
  const operations = createTestProgressPort()
  const logger = createTestLoggerService()
  const privacy = createAssetPrivacyService({
    noteFile: files,
    xArchive: createTestXArchiveService(),
    assetReferences: refs,
  })
  /**
   * Every asset the privacy gate classified, in order: one per asset a pass reached.
   */
  const classified: string[] = []
  /**
   * Every asset whose bytes were read, in order.
   */
  const assetReads: string[] = []
  const appliedListeners = new Set<(event: IndexAppliedEvent) => void>()
  /**
   * Every `reindexNotesReferencing` call, as `[assetPaths, generations]`.
   */
  const reindexed: Array<
    [readonly string[], { readonly generation: number; readonly fileGeneration: number }]
  > = []
  const index = {
    /**
     * When set, the next re-index rejects with it.
     */
    reindexError: null as Error | null,
    listenerCount: () => appliedListeners.size,
    emit(changes: FileChange[], generation: number = INDEX_GENERATION): void {
      for (const listener of appliedListeners) {
        listener({ generation, changes })
      }
    },
  }
  const provider = options?.provider === undefined ? PROVIDER : options.provider
  const graphSession = createTestGraphSessionService({
    graph: { generation: GENERATION, indexGeneration: INDEX_GENERATION },
  })
  const readBase64 = assetStore.readBase64.bind(assetStore)
  vi.spyOn(assetStore, 'readBase64').mockImplementation(async (path, generation) => {
    assetReads.push(path)
    return await readBase64(path, generation)
  })
  const classifyAsset = privacy.classifyAsset.bind(privacy)
  vi.spyOn(privacy, 'classifyAsset').mockImplementation(async (assetPath, generation) => {
    classified.push(assetPath)
    return await classifyAsset(assetPath, generation)
  })
  const aiCredentials = createAiCredentialService({
    secretStore:
      options?.secretStore ??
      createTestSecretStoreService({ 'ai-api-key:cfg-anthropic': 'sk-live' }),
  })
  const aiProviderConfig = createAiProviderConfigService({
    settings: createTestSettingsService(),
    credentials: aiCredentials,
    keyValidation: createTestAiKeyValidationService(),
    id: createTestIdService(),
  })
  vi.spyOn(aiProviderConfig, 'defaultProvider').mockImplementation(() => provider)
  const indexLifecycle = createTestIndexLifecycleService()
  vi.spyOn(indexLifecycle, 'onApplied').mockImplementation((listener) => {
    appliedListeners.add(listener)
    return () => {
      appliedListeners.delete(listener)
    }
  })
  vi.spyOn(indexLifecycle, 'reindexNotesReferencing').mockImplementation(
    (assetPaths, generations) => {
      reindexed.push([assetPaths, generations])
      if (index.reindexError !== null) {
        const error = index.reindexError
        index.reindexError = null
        return Promise.reject(error)
      }
      return Promise.resolve()
    },
  )
  const service = createAssetDescriptionService({
    assetStore,
    noteFile: files,
    assetPrivacy: privacy,
    assetDescriber: describer,
    aiProviderConfig,
    aiCredentials,
    clock,
    reconcilers: createBackgroundReconcilerFactory({ activity }),
    indexLifecycle,
    progress: operations,
    graphSession,
    logger,
  })
  let indexedEvents = 0
  service.onDescriptionsIndexed(() => {
    indexedEvents += 1
  })
  /**
   * Put an asset into the graph: its bytes in the asset store and its file in the listing.
   */
  async function addAsset(path: string, base64: string): Promise<void> {
    await assetStore.writeBase64(path, base64, GENERATION)
    files.set(path, atob(base64), { modifiedMs: 1 }) // far before any ISO `generatedAt`
  }
  return {
    service,
    graphSession,
    files,
    refs,
    describer,
    activity,
    operations,
    logger,
    classified,
    assetReads,
    reindexed,
    index,
    indexedEvents: () => indexedEvents,
    addAsset,
    reconcile: async (overrides: Partial<ReconcileAssetDescriptionsInput> = {}) =>
      await service.reconcile({
        generation: GENERATION,
        mode: 'incremental',
        changed: ['assets/a.png'],
        ...overrides,
      }),
  }
}

describe('pure helpers', () => {
  it('assetTypeFor maps eligible extensions and rejects the rest', () => {
    expect(assetTypeFor('assets/a.png')).toEqual({ kind: 'image', mediaType: 'image/png' })
    expect(assetTypeFor('assets/a.JPG')).toEqual({ kind: 'image', mediaType: 'image/jpeg' })
    expect(assetTypeFor('assets/a.jpeg')).toEqual({ kind: 'image', mediaType: 'image/jpeg' })
    expect(assetTypeFor('assets/a.gif')).toEqual({ kind: 'image', mediaType: 'image/gif' })
    expect(assetTypeFor('assets/a.webp')).toEqual({ kind: 'image', mediaType: 'image/webp' })
    expect(assetTypeFor('assets/a.svg')).toEqual({ kind: 'svg', mediaType: 'image/svg+xml' })
    expect(assetTypeFor('assets/a.pdf')).toEqual({ kind: 'pdf', mediaType: 'application/pdf' })
    expect(assetTypeFor('assets/a.txt')).toBeNull()
    expect(assetTypeFor('notes/a.png')).toBeNull()
    expect(assetTypeFor('assets/a.png.reflect.md')).toBeNull() // never describe a description
    expect(assetTypeFor('assets/noext')).toBeNull()
  })

  it('isEligibleAssetPath and descriptionPathFor', () => {
    expect(isEligibleAssetPath('assets/a.png')).toBe(true)
    expect(isEligibleAssetPath('assets/a.png.reflect.md')).toBe(false)
    expect(descriptionPathFor('assets/a.png')).toBe('assets/a.png.reflect.md')
  })

  it('readManagedDescription recognizes managed files and rejects user-authored ones', () => {
    const built = buildDescriptionSource(
      {
        source: 'assets/a.png',
        sourceHash: 'abc',
        sourceSize: 5,
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        generatedAt: '2026-06-16T00:00:00.000Z',
      },
      'A flow diagram.',
    )
    expect(readManagedDescription(built)).toEqual({
      sourceHash: 'abc',
      sourceSize: 5,
      generatedAtMs: Date.parse('2026-06-16T00:00:00.000Z'),
    })
    expect(built).toContain('A flow diagram.')
    expect(built).toContain('source: assets/a.png')
    // A file the user wrote (no managed marker) is never claimed.
    expect(readManagedDescription('# My own notes about this image\n')).toBeNull()
    expect(readManagedDescription('---\ntitle: Hand written\n---\n\nbody\n')).toBeNull()
  })
})

describe('AssetDescriptionService.reconcile', () => {
  it('describes a public asset and writes a managed, generation-pinned description', async () => {
    const { files, refs, addAsset, reconcile } = setup()
    await addAsset('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])

    const outcome = await reconcile()

    expect(outcome.described).toBe(1)
    expect(outcome.describedAssetPaths).toEqual(['assets/a.png'])
    expect(outcome.stopped).toBeNull()
    const hash = await sha256Hex('aGVsbG8=')
    const written = files.files().get('assets/a.png.reflect.md')!
    expect(readManagedDescription(written)).toMatchObject({ sourceHash: hash })
    expect(written).toContain('A flow diagram.')
    expect(written).toContain('provider: anthropic')
    expect(written).toContain('generatedAt: 2026-06-16T00:00:00.000Z')
    expect(files.writes()).toEqual([
      { path: 'assets/a.png.reflect.md', contents: written, generation: GENERATION },
    ])
  })

  it('skips an up-to-date managed description without calling the provider', async () => {
    const { files, refs, addAsset, describer, reconcile } = setup()
    await addAsset('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])
    const hash = await sha256Hex('aGVsbG8=')
    files.set(
      'assets/a.png.reflect.md',
      buildDescriptionSource(
        {
          source: 'assets/a.png',
          sourceHash: hash,
          sourceSize: 5,
          provider: 'anthropic',
          model: 'm',
          generatedAt: 'x',
        },
        'old',
      ),
    )

    const outcome = await reconcile()

    expect(outcome.skippedUpToDate).toBe(1)
    expect(outcome.described).toBe(0)
    expect(describer.calls()).toEqual([])
  })

  it('re-reads and rehashes a same-size replacement instead of trusting mtime/size', async () => {
    const { files, refs, addAsset, assetReads, reconcile } = setup()
    // A `cp -p`-style replacement: same byte size, mtime not advanced, different
    // content. The hash differs, so it must be re-described — never stat-skipped.
    await addAsset('assets/a.png', 'Ym9keTI=') // "body2", 5 bytes
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])
    files.set(
      'assets/a.png.reflect.md',
      buildDescriptionSource(
        {
          source: 'assets/a.png',
          sourceHash: 'stale-hash-of-the-old-5-byte-file',
          sourceSize: 5, // same size as the new bytes
          provider: 'anthropic',
          model: 'm',
          generatedAt: '2026-06-16T00:00:00.000Z', // at/after the stat mtime
        },
        'old description',
      ),
    )

    const outcome = await reconcile()

    expect(assetReads).toEqual(['assets/a.png']) // the bytes are read + rehashed
    expect(outcome.described).toBe(1) // hash differs → re-described, not skipped
    expect(outcome.skippedUpToDate).toBe(0)
  })

  it('regenerates a managed description when the source hash changed', async () => {
    const { files, refs, addAsset, reconcile } = setup()
    await addAsset('assets/a.png', 'bmV3Qnl0ZXM=') // different bytes
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])
    files.set(
      'assets/a.png.reflect.md',
      buildDescriptionSource(
        {
          source: 'assets/a.png',
          sourceHash: 'oldhash',
          sourceSize: 5,
          provider: 'anthropic',
          model: 'm',
          generatedAt: 'x',
        },
        'old',
      ),
    )

    const outcome = await reconcile()

    expect(outcome.described).toBe(1)
    expect(files.files().get('assets/a.png.reflect.md')).toContain('A flow diagram.')
  })

  it('never overwrites a user-authored description', async () => {
    const { files, refs, addAsset, describer, reconcile } = setup()
    await addAsset('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])
    files.set('assets/a.png.reflect.md', '# My own caption\n')

    const outcome = await reconcile()

    expect(outcome.skippedUserAuthored).toBe(1)
    expect(outcome.described).toBe(0)
    expect(files.files().get('assets/a.png.reflect.md')).toBe('# My own caption\n')
    expect(describer.calls()).toEqual([])
  })

  it('blocks an asset referenced by a private note', async () => {
    const { files, refs, addAsset, describer, reconcile } = setup()
    await addAsset('assets/a.png', 'aGVsbG8=')
    files.set('notes/secret.md', privateNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/secret.md'])

    const outcome = await reconcile()

    expect(outcome.skippedPrivate).toBe(1)
    expect(outcome.described).toBe(0)
    expect(describer.calls()).toEqual([])
    expect(files.files().has('assets/a.png.reflect.md')).toBe(false)
  })

  it('skips an unreferenced asset', async () => {
    const { refs, addAsset, describer, reconcile } = setup()
    await addAsset('assets/a.png', 'aGVsbG8=')
    refs.set('assets/a.png', [])

    const outcome = await reconcile()

    expect(outcome.skippedUnreferenced).toBe(1)
    expect(describer.calls()).toEqual([])
  })

  it('never reads an asset until a non-private note is associated (gate before attempt)', async () => {
    const { files, refs, addAsset, describer, assetReads, reconcile } = setup()
    await addAsset('assets/secret.png', 'aGVsbG8=')
    await addAsset('assets/orphan.png', 'aGVsbG8=')
    files.set('notes/secret.md', privateNote('assets/secret.png'))
    refs.set('assets/secret.png', ['notes/secret.md']) // referenced only by a private note
    refs.set('assets/orphan.png', []) // referenced by nothing

    const outcome = await reconcile({ changed: ['assets/secret.png', 'assets/orphan.png'] })

    expect(outcome.skippedPrivate).toBe(1)
    expect(outcome.skippedUnreferenced).toBe(1)
    expect(assetReads).toEqual([]) // bytes never touched
    expect(describer.calls()).toEqual([])
  })

  it('logs a permanent refusal and writes no description, continuing the pass', async () => {
    const { files, refs, addAsset, describer, reconcile } = setup()
    await addAsset('assets/a.png', 'aGVsbG8=')
    await addAsset('assets/b.pdf', 'JVBERg==')
    files.set('notes/pub.md', `# Both\n\n![](assets/a.png)\n![](assets/b.pdf)\n`)
    refs.set('assets/a.png', ['notes/pub.md'])
    refs.set('assets/b.pdf', ['notes/pub.md'])
    describer.setResult((request) => {
      if (request.filename === 'a.png') {
        throw new AssetDescriptionRejectedError('unsupported')
      }
      return 'A PDF.'
    })

    const outcome = await reconcile({ changed: ['assets/a.png', 'assets/b.pdf'] })

    expect(outcome.refused).toBe(1)
    expect(outcome.described).toBe(1)
    expect(outcome.stopped).toBeNull()
    expect(files.files().has('assets/a.png.reflect.md')).toBe(false)
    expect(files.files().has('assets/b.pdf.reflect.md')).toBe(true)
  })

  it('stops the pass on a transient (network) provider error for a later retry', async () => {
    const { files, refs, addAsset, describer, reconcile } = setup()
    await addAsset('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])
    describer.setResult(() => {
      throw new AppError('network', 'offline')
    })

    const outcome = await reconcile()

    expect(outcome.stopped).toEqual({ reason: 'network', message: 'offline' })
    expect(outcome.described).toBe(0)
    expect(files.files().has('assets/a.png.reflect.md')).toBe(false)
  })

  it('stops with a config reason when no provider is configured', async () => {
    const { refs, addAsset, describer, reconcile } = setup({ provider: null })
    await addAsset('assets/a.png', 'aGVsbG8=')
    refs.set('assets/a.png', ['notes/pub.md'])

    const outcome = await reconcile()

    expect(outcome.stopped?.reason).toBe('config')
    expect(describer.calls()).toEqual([])
  })

  it('stops with a config reason when the API key is missing from the keychain', async () => {
    const secretStore = createTestSecretStoreService()
    vi.spyOn(secretStore, 'get').mockRejectedValue(new Error('no key'))
    const { refs, addAsset, describer, reconcile } = setup({ secretStore })
    await addAsset('assets/a.png', 'aGVsbG8=')
    refs.set('assets/a.png', ['notes/pub.md'])
    const outcome = await reconcile()

    expect(outcome.stopped?.reason).toBe('config')
    expect(describer.calls()).toEqual([])
  })

  it('aborts before processing when the graph session ends', async () => {
    const { files, refs, addAsset, describer, reconcile } = setup()
    await addAsset('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])

    const outcome = await reconcile({ isStale: () => true })

    expect(outcome.stopped?.reason).toBe('stale')
    expect(outcome.described).toBe(0)
    expect(describer.calls()).toEqual([])
  })

  it('backfill enumerates every eligible asset and reports progress', async () => {
    const { files, refs, addAsset, reconcile } = setup()
    await addAsset('assets/a.png', 'aGVsbG8=')
    await addAsset('assets/b.pdf', 'JVBERg==')
    await addAsset('assets/notes.txt', 'aGk=') // ineligible — never listed as a candidate
    files.set('notes/pub.md', `# Both\n\n![](assets/a.png)\n![](assets/b.pdf)\n`)
    refs.set('assets/a.png', ['notes/pub.md'])
    refs.set('assets/b.pdf', ['notes/pub.md'])
    const progress: Array<[number, number]> = []

    const outcome = await reconcile({
      // `changed` is ignored in backfill mode — the listing enumerates the candidates.
      mode: 'backfill',
      onProgress: (done, total) => void progress.push([done, total]),
    })

    expect(outcome.pending).toBe(2)
    expect(outcome.described).toBe(2)
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ])
  })
})

describe('AssetDescriptionService.openSession', () => {
  /**
   * A graph where `assets/a.png` and `assets/b.pdf` are public and describable.
   */
  async function describable(options?: Parameters<typeof setup>[0]) {
    const context = setup(options)
    await context.addAsset('assets/a.png', 'aGVsbG8=')
    await context.addAsset('assets/b.pdf', 'JVBERg==')
    context.files.set('notes/pub.md', `# Both\n\n![](assets/a.png)\n![](assets/b.pdf)\n`)
    context.refs.set('assets/a.png', ['notes/pub.md'])
    context.refs.set('assets/b.pdf', ['notes/pub.md'])
    const session = context.service.openSession({
      generation: GENERATION,
      indexGeneration: INDEX_GENERATION,
    })
    return { ...context, session }
  }

  it('runs no launch pass — existing assets are never auto-scanned', async () => {
    const { session, classified } = await describable()
    session.start()
    await settle()
    expect(classified).toEqual([])
  })

  it('describes a newly observed eligible asset, pinned to the generation', async () => {
    const { session, index, classified, describer, files } = await describable()
    session.start()
    index.emit([upsert('assets/a.png')])

    await vi.waitFor(() => {
      expect(classified).toEqual(['assets/a.png'])
      expect(describer.calls()).toHaveLength(1)
      expect(files.writes().map((write) => [write.path, write.generation])).toEqual([
        ['assets/a.png.reflect.md', GENERATION],
      ])
    })
  })

  it('re-indexes the notes referencing assets it described, so the text is searchable', async () => {
    const { session, index, reindexed, indexedEvents } = await describable()
    session.start()
    index.emit([upsert('assets/a.png')])

    await vi.waitFor(() => {
      expect(reindexed).toEqual([
        [['assets/a.png'], { generation: INDEX_GENERATION, fileGeneration: GENERATION }],
      ])
      // The re-index wrote search rows directly, so index-backed caches must be
      // told for ⌘K to reflect the new descriptions.
      expect(indexedEvents()).toBe(1)
    })
  })

  it('still reports the descriptions as indexed when the re-index fails, and logs it', async () => {
    const { session, index, logger, indexedEvents } = await describable()
    const failure = new AppError('io', 'index closed')
    index.reindexError = failure
    session.start()
    index.emit([upsert('assets/a.png')])

    await vi.waitFor(() => {
      expect(indexedEvents()).toBe(1)
      expect(logger.getWarnings()).toEqual([
        { message: 'asset-description re-index failed:', cause: failure },
      ])
    })
  })

  it('does not re-index when nothing was described this pass', async () => {
    const { session, index, refs, classified, reindexed, indexedEvents } = await describable()
    refs.set('assets/a.png', []) // unreferenced: skipped, nothing written
    session.start()
    index.emit([upsert('assets/a.png')])

    await vi.waitFor(() => expect(classified).toEqual(['assets/a.png']))
    await settle()
    expect(reindexed).toEqual([])
    expect(indexedEvents()).toBe(0)
  })

  it('ignores descriptions, ineligible types, removes, and notes with no asset refs', async () => {
    const { session, index, files, classified } = await describable()
    files.set('notes/x.md', '# A note with no asset references\n')
    session.start()
    index.emit([
      upsert('assets/a.png.reflect.md'),
      upsert('assets/notes.txt'),
      { path: 'assets/a.png', kind: 'remove' },
      upsert('notes/x.md'),
    ])
    await settle()

    expect(classified).toEqual([])
  })

  it('re-evaluates assets referenced by a changed note (an asset newly made public)', async () => {
    const { session, index, files, classified } = await describable()
    files.set('notes/x.md', '# Now public\n\n![](assets/a.png)\n')
    session.start()
    index.emit([upsert('notes/x.md')])

    await vi.waitFor(() => expect(classified).toEqual(['assets/a.png']))
  })

  it('coalesces a trigger that lands mid-pass into one follow-up', async () => {
    const { session, index, describer, classified } = await describable()
    const first = Promise.withResolvers<string>()
    describer.setResult((request) => (request.filename === 'a.png' ? first.promise : 'A PDF.'))
    session.start()

    index.emit([upsert('assets/a.png')]) // starts the pass (now in-flight)
    await vi.waitFor(() => expect(describer.calls()).toHaveLength(1))
    index.emit([upsert('assets/b.pdf')]) // lands mid-pass → queued
    await settle()
    expect(classified).toEqual(['assets/a.png'])

    first.resolve('A flow diagram.') // clears a.png; the follow-up runs for b.pdf

    await vi.waitFor(() => expect(classified).toEqual(['assets/a.png', 'assets/b.pdf']))
  })

  it('keeps an asset dirty after a transient stop and retries it on wake', async () => {
    const { session, index, describer, activity, logger, files } = await describable()
    describer.setResult(() => {
      throw new AppError('network', 'offline')
    })
    session.start()

    index.emit([upsert('assets/a.png')])
    await vi.waitFor(() => expect(describer.calls()).toHaveLength(1))
    await settle()
    expect(logger.getWarnings()).toEqual([]) // a network stop heals itself: never logged

    describer.setResult('A flow diagram.')
    activity.emitWake() // back online → retry the leftover

    await vi.waitFor(() => {
      expect(describer.calls()).toHaveLength(2)
      expect(files.files().has('assets/a.png.reflect.md')).toBe(true)
    })
  })

  it('logs an unexpected stop once, not on every retry', async () => {
    const { session, index, describer, activity, logger } = await describable()
    describer.setResult(() => {
      throw new AppError('io', 'index not ready')
    })
    session.start()

    index.emit([upsert('assets/a.png')])
    await vi.waitFor(() => expect(describer.calls()).toHaveLength(1))
    await settle()
    activity.emitWake()
    await vi.waitFor(() => expect(describer.calls()).toHaveLength(2))
    await settle()

    expect(logger.getWarnings()).toEqual([
      { message: 'asset description stopped (io): index not ready', cause: undefined },
    ])
  })

  it('does not retry an asset a clean pass already handled', async () => {
    const { session, index, activity, classified } = await describable()
    session.start()

    index.emit([upsert('assets/a.png')])
    await vi.waitFor(() => expect(classified).toEqual(['assets/a.png']))
    activity.emitWake()
    await settle()

    expect(classified).toEqual(['assets/a.png'])
  })

  it('dispose unlistens and stops further passes', async () => {
    const { session, index, classified } = await describable()
    session.start()
    expect(index.listenerCount()).toBe(1)
    session.dispose()

    expect(index.listenerCount()).toBe(0)
    index.emit([upsert('assets/a.png')])
    session.schedule()
    await settle()
    expect(classified).toEqual([])
  })

  it('start is idempotent — repeated calls do not duplicate subscriptions or passes', async () => {
    const { session, index, classified } = await describable()
    session.start()
    session.start() // second call must be a no-op
    await settle()

    expect(index.listenerCount()).toBe(1)
    index.emit([upsert('assets/a.png')])
    await vi.waitFor(() => expect(classified).toEqual(['assets/a.png']))
    await settle()
    expect(classified).toEqual(['assets/a.png']) // one pass, not two
  })

  it('ignores a post-apply batch from a different graph generation', async () => {
    const { session, index, classified } = await describable()
    session.start()

    index.emit([upsert('assets/a.png')], INDEX_GENERATION + 1) // a stale emit from another graph
    await settle()
    expect(classified).toEqual([])

    index.emit([upsert('assets/a.png')]) // our generation → processed
    await vi.waitFor(() => expect(classified).toEqual(['assets/a.png']))
  })

  it('follows the index generation, not the file generation', async () => {
    const { session, index, classified } = await describable()
    session.start()

    index.emit([upsert('assets/a.png')], GENERATION)
    await settle()
    expect(classified).toEqual([])

    index.emit([upsert('assets/a.png')], INDEX_GENERATION)
    await vi.waitFor(() => expect(classified).toEqual(['assets/a.png']))
  })
})

describe('AssetDescriptionService.backfillVisibly', () => {
  it('describes every eligible asset, re-indexes the referencing notes, and finishes the operation', async () => {
    const { service, files, refs, addAsset, operations, reindexed, indexedEvents } = setup()
    await addAsset('assets/a.png', 'aGVsbG8=')
    await addAsset('assets/b.pdf', 'JVBERg==')
    files.set('notes/pub.md', `# Both\n\n![](assets/a.png)\n![](assets/b.pdf)\n`)
    refs.set('assets/a.png', ['notes/pub.md'])
    refs.set('assets/b.pdf', ['notes/pub.md'])

    const running = service.backfillVisibly()
    expect(operations.findByLabel('Describing assets')).toMatchObject({ status: 'running' })
    const outcome = await running

    expect(outcome.described).toBe(2)
    expect(reindexed).toEqual([
      [
        ['assets/a.png', 'assets/b.pdf'],
        { generation: INDEX_GENERATION, fileGeneration: GENERATION },
      ],
    ])
    expect(indexedEvents()).toBe(1)
    expect(operations.getAll().filter((operation) => operation.status !== 'running')).toEqual([])
  })

  it('describes without re-indexing when the index failed to open', async () => {
    const { service, graphSession, files, refs, addAsset, reindexed, indexedEvents } = setup()
    graphSession.setGraph({ generation: GENERATION, indexGeneration: null })
    await addAsset('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', `# A\n\n![](assets/a.png)\n`)
    refs.set('assets/a.png', ['notes/pub.md'])

    const outcome = await service.backfillVisibly()

    expect(outcome.described).toBe(1)
    expect(reindexed).toEqual([])
    expect(indexedEvents()).toBe(0)
  })

  it('stops without an operation when no graph is open', async () => {
    const { service, graphSession, operations, describer } = setup()
    graphSession.setGraph(null)

    const outcome = await service.backfillVisibly()

    expect(outcome.stopped).toEqual({ reason: 'noGraph', message: 'No graph is open.' })
    expect(operations.getAll()).toEqual([])
    expect(describer.calls()).toEqual([])
  })

  it('coalesces a second request for the same graph into the run in flight', async () => {
    const { service, files, refs, addAsset, describer } = setup()
    await addAsset('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])

    const first = service.backfillVisibly()
    const second = service.backfillVisibly()

    expect(second).toBe(first)
    await first
    expect(describer.calls()).toHaveLength(1)
  })

  it('warns when no AI provider is configured', async () => {
    const { service, addAsset, operations } = setup({ provider: null })
    await addAsset('assets/a.png', 'aGVsbG8=')

    const outcome = await service.backfillVisibly()

    expect(outcome.stopped?.reason).toBe('config')
    expect(operations.findByLabel('Describing assets')).toMatchObject({
      status: 'warning',
      message: 'Add an AI provider in Settings to describe assets.',
    })
  })

  it('warns on a network stop and fails on any other', async () => {
    const { service, files, refs, addAsset, describer, operations } = setup()
    await addAsset('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])

    describer.setResult(() => {
      throw new AppError('network', 'offline')
    })
    await service.backfillVisibly()
    expect(operations.findByLabel('Describing assets')).toMatchObject({
      status: 'warning',
      message: 'Some assets could not be described — check your connection and try again.',
    })

    describer.setResult(() => {
      throw new AppError('io', 'disk error')
    })
    await service.backfillVisibly()
    expect(operations.findByLabel('Describing assets')).toMatchObject({
      status: 'failed',
      message: 'disk error',
    })
  })
})
