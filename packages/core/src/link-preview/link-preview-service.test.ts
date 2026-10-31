import { describe, expect, it } from 'vitest'
import { createNoteDocumentService } from '../documents/note-document-service.ts'
import { createOpenDocumentsService } from '../documents/open-documents-service.ts'
import { createPrivacyService } from '../privacy/privacy-service.ts'
import {
  createTestFileChangeService,
  createTestGraphSessionService,
  createTestNoteFileService,
  createTestWebFetchService,
} from '../testing/index.ts'
import { createLinkPreviewService, type LinkPreviewSession } from './link-preview-service.ts'

const session: LinkPreviewSession = {
  path: 'notes/a.md',
  graphKey: '/graph-a',
  sessionEpoch: 3,
}
const PAGE = 'https://example.com/page'
const ICON = 'https://example.com/icon.png'
const ICON_SRC = 'data:image/png;base64,aGVsbG8='

function setup(source: string) {
  const noteFile = createTestNoteFileService({ files: { [session.path]: source } })
  const webFetch = createTestWebFetchService({
    html: { [PAGE]: '<title>Example title</title>' },
    icon: { [ICON]: ICON_SRC },
  })
  const linkPreview = createLinkPreviewService({
    noteDocuments: createNoteDocumentService({
      openDocuments: createOpenDocumentsService({ fileChanges: createTestFileChangeService() }),
      noteFile,
      graphSession: createTestGraphSessionService({ graph: { generation: 3 } }),
    }),
    privacy: createPrivacyService({
      noteFile: createTestNoteFileService(),
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
    }),
    webFetch,
    // The real parser needs a `DOMParser`.
    parseMetadata: () => ({ title: 'Example title', description: null, iconUrl: ICON }),
    graphSession: createTestGraphSessionService({ graph: { generation: 7 } }),
  })
  return { noteFile, webFetch, linkPreview }
}

describe('LinkPreviewService.createResolver', () => {
  it('resolves a link of a public note once per session resolver', async () => {
    const { webFetch, linkPreview } = setup('# Public')
    const resolver = linkPreview.createResolver(session, () => session)

    await expect(resolver(PAGE)).resolves.toEqual({ title: 'Example title', iconSrc: ICON_SRC })
    await expect(resolver(PAGE)).resolves.toEqual({ title: 'Example title', iconSrc: ICON_SRC })

    expect(webFetch.requests()).toEqual([
      { kind: 'html', url: PAGE },
      { kind: 'icon', url: ICON },
    ])
  })

  it('fetches nothing for a private note, and resolves once the note is public again', async () => {
    const { noteFile, webFetch, linkPreview } = setup('---\nprivate: true\n---\n# Private')
    const resolver = linkPreview.createResolver(session, () => session)

    await expect(resolver(PAGE)).resolves.toBeUndefined()
    expect(webFetch.requests()).toEqual([])

    noteFile.set(session.path, '# Public')
    await expect(resolver(PAGE)).resolves.toMatchObject({ title: 'Example title' })
  })

  it('fetches nothing for a replaced editor session or a non-HTTP link', async () => {
    const { webFetch, linkPreview } = setup('# Public')
    const replaced = linkPreview.createResolver(session, () => ({ ...session, sessionEpoch: 4 }))
    const current = linkPreview.createResolver(session, () => session)

    await expect(replaced(PAGE)).resolves.toBeUndefined()
    await expect(current('mailto:a@example.com')).resolves.toBeUndefined()
    expect(webFetch.requests()).toEqual([])
  })

  it('keeps each resolver its own cache', async () => {
    const { webFetch, linkPreview } = setup('# Public')
    await linkPreview.createResolver(session, () => session)(PAGE)
    await linkPreview.createResolver(session, () => session)(PAGE)
    expect(webFetch.requests().filter((request) => request.kind === 'html')).toHaveLength(2)
  })
})
