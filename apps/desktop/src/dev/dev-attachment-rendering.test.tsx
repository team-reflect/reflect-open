import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { setBridge } from '@reflect/core'
import { createDevAttachmentStore } from '@/dev/dev-attachment-store'
import { createDevBridge } from '@/dev/dev-bridge'
import { createDevFileStore } from '@/dev/dev-file-store'
import { createDevIndexDb } from '@/dev/dev-index-db'
import { MarkdownPreview } from '@/editor/markdown-preview'
import { useAssetPersistence } from '@/editor/use-asset-persistence'
import { installBrowserAttachmentUrlResolver } from '@/lib/attachment-display-url'
import { AttachmentCatalogProvider } from '@/providers/attachment-catalog-provider'

const tauriUrl = vi.hoisted(() => vi.fn(() => 'tauri-url-must-not-be-used'))

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: tauriUrl }))
vi.mock('@/editor/open-external-link', () => ({ useOpenExternalLink: () => vi.fn() }))
vi.mock('@meowdown/react', () => ({
  // MarkdownView itself needs a browser layout engine, which jsdom does not
  // provide. This thin stand-in preserves its resolver boundary and renders
  // the resulting URL into the same image element the real view produces.
  MarkdownView: ({
    markdown,
    resolveImageUrl,
  }: {
    markdown: string
    resolveImageUrl?: (source: string) => string | undefined
  }) => {
    const source = /!\[[^\]]*\]\(([^)]+)\)/.exec(markdown)?.[1]
    const displayUrl = source === undefined ? undefined : resolveImageUrl?.(source)
    return displayUrl === undefined ? null : <img alt="Seeded attachment" src={displayUrl} />
  },
}))

let removeBrowserResolver: (() => void) | null = null

afterEach(() => {
  cleanup()
  removeBrowserResolver?.()
  removeBrowserResolver = null
  setBridge(null)
  tauriUrl.mockClear()
})

function DevAttachmentPreview(): ReactNode {
  const persistence = useAssetPersistence(1, 'daily/2026-07-14.md')
  return (
    <MarkdownPreview
      content="![Seeded attachment](/Media/reflect-dev.png)"
      resolveImageUrl={persistence.resolveImageUrl}
      resolverRevision={persistence.attachmentCatalogRevision}
    />
  )
}

describe('plain-browser development attachment rendering', () => {
  it('renders a seeded image through a Blob URL without calling Tauri', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:https://reflect.test/seeded-image')
    const attachments = createDevAttachmentStore(
      1,
      { 'Media/reflect-dev.png': 'iVBORw==' },
      { createObjectURL, revokeObjectURL: vi.fn((_url: string) => {}) },
    )
    const bridge = createDevBridge({
      platform: 'ios',
      files: createDevFileStore({
        'daily/2026-07-14.md': '![Seeded attachment](/Media/reflect-dev.png)',
      }),
      index: await createDevIndexDb(),
      attachments,
    })
    setBridge(bridge)
    removeBrowserResolver = installBrowserAttachmentUrlResolver(
      attachments.displayUrl,
      attachments.dispose,
    )

    render(
      <AttachmentCatalogProvider generation={1}>
        <DevAttachmentPreview />
      </AttachmentCatalogProvider>,
    )

    const image = await screen.findByRole('img', { name: 'Seeded attachment' })
    await waitFor(() => expect(image.getAttribute('src')).toBe('blob:https://reflect.test/seeded-image'))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(tauriUrl).not.toHaveBeenCalled()
  })
})
