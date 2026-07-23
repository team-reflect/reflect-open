import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo } from '@reflect/core'
import {
  dispatchDeepLink,
  resetDeepLinkIntakeForTests,
} from '@/lib/deep-links/intake'

const resolveNoteTarget = vi.hoisted(() => vi.fn())
const captureInboxSpool = vi.hoisted(() => vi.fn(async () => {}))
const navigate = vi.hoisted(() => vi.fn())
const navigation = vi.hoisted(() => ({ revision: 0 }))
const operationHandle = vi.hoisted(() => ({
  progress: vi.fn(),
  done: vi.fn(),
  warn: vi.fn(),
  fail: vi.fn(),
  dismiss: vi.fn(),
}))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  resolveNoteTarget,
  captureInboxSpool,
}))
vi.mock('@/lib/operations', () => ({
  startOperation: vi.fn(() => operationHandle),
}))
vi.mock('@/routing/router', () => ({
  useRouter: () => ({ navigate, navigationRevision: () => navigation.revision }),
}))

import { DeepLinkProvider } from './deep-link-provider'

const GRAPH: GraphInfo = { root: '/g', name: 'g', generation: 7 }

beforeEach(() => {
  vi.clearAllMocks()
  resetDeepLinkIntakeForTests()
  navigation.revision = 0
})

afterEach(() => {
  resetDeepLinkIntakeForTests()
})

describe('DeepLinkProvider navigation intent integration', () => {
  it('keeps a deferred note resolution current when a capture arrives', async () => {
    let finishResolution: (path: string) => void = () => {}
    resolveNoteTarget.mockReturnValue(
      new Promise((resolve) => {
        finishResolution = resolve
      }),
    )
    await render(<DeepLinkProvider graph={GRAPH}>{null}</DeepLinkProvider>)

    dispatchDeepLink('reflect://note/Project%20X')
    expect(resolveNoteTarget).toHaveBeenCalledWith('Project X')

    dispatchDeepLink('reflect://append?text=captured%20while%20resolving')
    await vi.waitFor(() => expect(captureInboxSpool).toHaveBeenCalledTimes(1))

    finishResolution('notes/project-x.md')

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'note', path: 'notes/project-x.md' }),
    )
  })
})
