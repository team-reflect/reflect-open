import {
  createDeepLinkIntakeService,
  type DeepLinkIntakeService,
  type DeepLinkIntakeServiceDeps,
  type DeepLinkResolveOptions,
  type DeepLinkSource,
  type DeepLinkTarget,
} from '../navigation/deep-link-intake-service.ts'
import { createIndexQueryService } from '../indexing/index-query-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { createTestCaptureInboxService } from './capture.ts'
import { createTestClockService } from './clock.ts'
import { createNodeTestDatabaseService } from './database.ts'
import { createTestGraphSessionService } from './graph-session.ts'
import { createTestIdService } from './id.ts'
import { createTestProgressPort } from './ports.ts'

export interface TestDeepLinkSource extends DeepLinkSource {
  /**
   * Deliver `urls` to every live subscription, as the operating system does.
   */
  deliver(urls: string[]): void
  /**
   * How many subscriptions are live.
   */
  subscriptionCount(): number
}

class TestDeepLinkSourceImpl implements TestDeepLinkSource {
  readonly #listeners = new Set<(urls: string[]) => void>()
  readonly #current: string[] | null

  constructor(options?: { current?: string[] | null }) {
    this.#current = options?.current ?? null
  }

  onOpenUrl(listener: (urls: string[]) => void): Unlisten {
    this.#listeners.add(listener)
    const unlisten: Unlisten = () => {
      this.#listeners.delete(listener)
    }
    return unlisten
  }

  getCurrent(): string[] | null {
    return this.#current
  }

  deliver(urls: string[]): void {
    for (const listener of this.#listeners) {
      listener(urls)
    }
  }

  subscriptionCount(): number {
    return this.#listeners.size
  }
}

/**

 * An in-memory {@link DeepLinkSource}; `current` holds the launch URLs.

 */
export function createTestDeepLinkSource(options?: {
  current?: string[] | null
}): TestDeepLinkSource {
  return new TestDeepLinkSourceImpl(options)
}

export interface TestDeepLinkIntakeServiceOptions extends Partial<DeepLinkIntakeServiceDeps> {
  /**
   * Note targets and the paths they resolve to, used without an `indexQuery`.
   * A missing target resolves to `null`.
   */
  notes?: Readonly<Record<string, string>>
}

export interface TestDeepLinkIntakeService extends DeepLinkIntakeService {
  /**
   * Every URL passed to `dispatch`, in order. Source deliveries are not included.
   */
  dispatched(): readonly string[]
}

class TestDeepLinkIntakeServiceImpl implements TestDeepLinkIntakeService {
  readonly #inner: DeepLinkIntakeService
  readonly #calls: string[] = []

  constructor(inner: DeepLinkIntakeService) {
    this.#inner = inner
  }

  startListener(): Promise<void> {
    return this.#inner.startListener()
  }

  dispatch(url: string): void {
    this.#calls.push(url)
    this.#inner.dispatch(url)
  }

  onUrl(listener: (url: string) => void): Unlisten {
    return this.#inner.onUrl(listener)
  }

  resolve(url: string, options?: DeepLinkResolveOptions): Promise<DeepLinkTarget> {
    return this.#inner.resolve(url, options)
  }

  dispatched(): readonly string[] {
    return [...this.#calls]
  }
}

/**
 * The real {@link DeepLinkIntakeService} over test doubles (a
 * {@link createTestDeepLinkSource} by default, and the test graph open with
 * generation 1), recording each `dispatch` call.
 */
export function createTestDeepLinkIntakeService(
  options?: TestDeepLinkIntakeServiceOptions,
): TestDeepLinkIntakeService {
  const notes = options?.notes ?? {}
  return new TestDeepLinkIntakeServiceImpl(
    createDeepLinkIntakeService({
      source: options?.source ?? createTestDeepLinkSource(),
      indexQuery:
        options?.indexQuery ??
        Object.assign(createIndexQueryService({ database: createNodeTestDatabaseService() }), {
          resolveNoteTarget: (target: string) => Promise.resolve(notes[target] ?? null),
        }),
      captureInbox: options?.captureInbox ?? createTestCaptureInboxService(),
      progress: options?.progress ?? createTestProgressPort(),
      id: options?.id ?? createTestIdService(),
      clock: options?.clock ?? createTestClockService(),
      graphSession: options?.graphSession ?? createTestGraphSessionService({ graph: {} }),
    }),
  )
}
