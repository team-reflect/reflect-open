import { vi } from 'vitest'
import { describePage } from '../ai/describe-page'
import type { AiProvidersState } from '../ai/provider-config'
import {
  captureInboxList,
  captureInboxRead,
  captureInboxReject,
  captureInboxRemove,
  captureLinkPreview,
  listFiles,
  promoteCaptureScreenshot,
  readAsset,
  readNote,
  writeAsset,
  writeNote,
} from '../graph/commands'
import { getSecret } from '../secrets/keychain'
import {
  captureIdentity,
  drainCaptureInbox,
  reconcileCaptureEnrichment,
  type ReconcileCaptureEnrichmentInput,
} from './capture'
import type { CaptureEnvelope } from './capture-envelope'
import { scrapePageMeta } from './meta-scrape'

/**
 * Shared in-memory harness for the capture test files (`capture-drain.test.ts`,
 * `capture-enrichment.test.ts`). The mocked commands read and write the maps
 * below, so a drain's writes are visible to its own dedup lookups, to later
 * drains, and to the enrichment pass — the cross-step behavior the contracts
 * are about.
 *
 * `vi.mock(...)` calls are hoisted per test file and cannot live here: each
 * test file declares its own mock blocks for `../graph/commands`,
 * `./meta-scrape`, `../ai/describe-page`, and `../secrets/keychain`, then
 * calls {@link wireCaptureMocks} from `beforeEach`.
 */

export const inboxListMock = vi.mocked(captureInboxList)
export const inboxReadMock = vi.mocked(captureInboxRead)
export const inboxRejectMock = vi.mocked(captureInboxReject)
export const inboxRemoveMock = vi.mocked(captureInboxRemove)
export const linkPreviewMock = vi.mocked(captureLinkPreview)
export const listFilesMock = vi.mocked(listFiles)
export const promoteMock = vi.mocked(promoteCaptureScreenshot)
export const readAssetMock = vi.mocked(readAsset)
export const readNoteMock = vi.mocked(readNote)
export const writeAssetMock = vi.mocked(writeAsset)
export const writeNoteMock = vi.mocked(writeNote)
export const scrapeMock = vi.mocked(scrapePageMeta)
export const describeMock = vi.mocked(describePage)
export const getSecretMock = vi.mocked(getSecret)

export const PROVIDERS: AiProvidersState = {
  providers: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.5', keyHint: 'wxyz1' }],
  defaultProviderId: 'cfg-openai',
}
export const NO_PROVIDERS: AiProvidersState = { providers: [], defaultProviderId: null }

/** 2026-06-11 15:30:22.845 local — every derived name is asserted from it. */
export const CAPTURED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
export const IDENTITY = captureIdentity(CAPTURED_AT, '7c9e6679-7425-40de-944b-e07fc1f90ae7')
export const DAILY = 'daily/2026-06-11.md'
export const CAPTURE_URL = 'https://example.com/article'

const notFound = () => ({ kind: 'notFound', message: 'missing' })

/** The in-memory graph: note/asset paths to contents. */
export const files = new Map<string, string>()
/** The in-memory spool (`.reflect/inbox/`). */
export const spool = new Map<string, { contents: string; modifiedMs: number }>()
/** What `captureInboxReject` moved into `.reflect/inbox-rejected/`. */
export const rejected = new Map<string, string>()

export function envelope(overrides: Partial<CaptureEnvelope> = {}): CaptureEnvelope {
  return {
    version: 1,
    id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    url: CAPTURE_URL,
    title: 'An article',
    capturedAt: CAPTURED_AT.toISOString(),
    source: 'extension',
    ...overrides,
  }
}

/** Spool one capture (envelope JSON + screenshot sibling unless disabled). */
export function addSpool(
  capture: CaptureEnvelope,
  options: { screenshot?: boolean; modifiedMs?: number } = {},
): void {
  const withRef = {
    ...capture,
    screenshotRef: options.screenshot === false ? undefined : `${capture.id}.jpg`,
  }
  spool.set(`${capture.id}.json`, {
    contents: JSON.stringify(withRef),
    modifiedMs: options.modifiedMs ?? 0,
  })
  if (options.screenshot !== false) {
    spool.set(`${capture.id}.jpg`, { contents: 'jpeg', modifiedMs: options.modifiedMs ?? 0 })
  }
}

export function drain(overrides: Partial<Parameters<typeof drainCaptureInbox>[0]> = {}) {
  return drainCaptureInbox({ generation: 3, ...overrides })
}

export function reconcile(overrides: Partial<ReconcileCaptureEnrichmentInput> = {}) {
  return reconcileCaptureEnrichment({ providers: PROVIDERS, generation: 3, ...overrides })
}

/** Reset the maps and point every mocked command at them; call from `beforeEach`. */
export function wireCaptureMocks(): void {
  vi.clearAllMocks()
  files.clear()
  spool.clear()
  rejected.clear()

  inboxListMock.mockImplementation(async () =>
    [...spool.entries()].map(([name, entry]) => ({
      path: `.reflect/inbox/${name}`,
      size: entry.contents.length,
      modifiedMs: entry.modifiedMs,
    })),
  )
  inboxReadMock.mockImplementation(async (name) => {
    const entry = spool.get(name)
    if (!entry) throw notFound()
    return entry.contents
  })
  inboxRemoveMock.mockImplementation(async (name) => {
    spool.delete(name)
  })
  inboxRejectMock.mockImplementation(async (name) => {
    const entry = spool.get(name)
    if (entry) {
      rejected.set(name, entry.contents)
      spool.delete(name)
    }
  })
  promoteMock.mockImplementation(async (spoolName) => {
    if (!spool.has(spoolName)) throw notFound()
  })
  readNoteMock.mockImplementation(async (path) => {
    const contents = files.get(path)
    if (contents === undefined) throw notFound()
    return contents
  })
  writeNoteMock.mockImplementation(async (path, contents) => {
    files.set(path, contents)
  })
  listFilesMock.mockImplementation(async () =>
    [...files.keys()].map((path) => ({ path, size: 1, modifiedMs: 0 })),
  )
  readAssetMock.mockResolvedValue(btoa('jpeg-bytes'))
  writeAssetMock.mockImplementation(async (path, contentsBase64) => {
    files.set(path, contentsBase64)
  })
  linkPreviewMock.mockResolvedValue(null)
  getSecretMock.mockResolvedValue('sk-live-key')
  scrapeMock.mockResolvedValue({ title: 'An article', description: null, siteName: null })
  describeMock.mockResolvedValue({ title: null, description: 'An AI description of the page.' })
}
