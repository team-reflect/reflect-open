import type { AssetDescriptionService } from '../assets/asset-description-service.ts'
import type { AssetReferences } from '../indexing/asset-refs.ts'

export interface TestAssetReferences extends AssetReferences {
  /**
   * Set the notes the index reports as referencing `assetPath`.
   */
  set(assetPath: string, notePaths: readonly string[]): void
}

class TestAssetReferencesImpl implements TestAssetReferences {
  readonly #table: Map<string, readonly string[]>

  constructor(references?: Readonly<Record<string, readonly string[]>>) {
    this.#table = new Map(Object.entries(references ?? {}))
  }

  notePaths(assetPath: string): string[] {
    return [...(this.#table.get(assetPath) ?? [])]
  }

  set(assetPath: string, notePaths: readonly string[]): void {
    this.#table.set(assetPath, notePaths)
  }
}

/**
 * {@link AssetReferences} that answer from a table instead of the index:
 * `references` maps an asset path to the notes that reference it.
 */
export function createTestAssetReferences(
  references?: Readonly<Record<string, readonly string[]>>,
): TestAssetReferences {
  return new TestAssetReferencesImpl(references)
}

export interface AssetDescriptionSessionRecord {
  generation: number
  indexGeneration: number | null
  starts: number
  schedules: number
  disposed: boolean
}

/**
 * Records each session that `service` opens: its options and how often it was
 * started, scheduled, and disposed. Returns a snapshot of the sessions so far.
 */
export function trackAssetDescriptionSessions(
  service: AssetDescriptionService,
): () => AssetDescriptionSessionRecord[] {
  const records: AssetDescriptionSessionRecord[] = []
  const open = service.openSession.bind(service)
  service.openSession = (options) => {
    const session = open(options)
    const record = {
      generation: options.generation,
      indexGeneration: options.indexGeneration,
      starts: 0,
      schedules: 0,
      disposed: false,
    }
    records.push(record)
    const start = session.start.bind(session)
    const schedule = session.schedule.bind(session)
    const dispose = session.dispose.bind(session)
    session.start = () => {
      record.starts += 1
      start()
    }
    session.schedule = () => {
      record.schedules += 1
      schedule()
    }
    session.dispose = () => {
      record.disposed = true
      dispose()
    }
    return session
  }
  return () => records.map((record) => ({ ...record }))
}
