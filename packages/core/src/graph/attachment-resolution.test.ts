import { describe, expect, it } from 'vitest'
import { assetReferenceMatches } from '../indexing/asset-refs.ts'
import { parseNote } from '../markdown/extract.ts'
import {
  createAttachmentCatalog,
  isImageAttachmentPath,
  resolveAttachmentLink,
  resolveWikiEmbedTarget,
  type AttachmentCatalog,
} from './attachment-resolution.ts'

function catalogOf(...paths: string[]): AttachmentCatalog {
  return createAttachmentCatalog(paths.map((path) => ({ path, size: path.length })))
}

const vault = catalogOf(
  'attachments/garden-budget.png',
  'Projects/attachments/plan.png',
  'assets/pasted-1.png',
  'Archive/logo.png',
  'Media/logo.png',
  'Projects/logo.png',
  'attachments/report.pdf',
)

describe('createAttachmentCatalog', () => {
  it('answers membership, size, and every file sharing a name', () => {
    const catalog = createAttachmentCatalog([
      { path: 'a/photo.png', size: 10 },
      { path: 'b/photo.png', size: 20 },
    ])
    expect(catalog.has('a/photo.png')).toBe(true)
    expect(catalog.has('photo.png')).toBe(false)
    expect(catalog.size('b/photo.png')).toBe(20)
    expect(catalog.size('c/photo.png')).toBeUndefined()
    expect(catalog.named('photo.png')).toEqual(['a/photo.png', 'b/photo.png'])
    expect(catalog.named('missing.png')).toEqual([])
  })
})

describe('resolveAttachmentLink', () => {
  it('resolves source-relative destinations from a nested note', () => {
    expect(
      resolveAttachmentLink(
        'Projects/Garden redesign.md',
        '../attachments/garden-budget.png',
        vault,
      ),
    ).toBe('attachments/garden-budget.png')
  })

  it('resolves a folder path from a root note', () => {
    expect(resolveAttachmentLink('Home.md', 'attachments/garden-budget.png', vault)).toBe(
      'attachments/garden-budget.png',
    )
  })

  it('prefers the source-relative file, then the vault-root one', () => {
    expect(resolveAttachmentLink('Projects/Plan.md', 'attachments/plan.png', vault)).toBe(
      'Projects/attachments/plan.png',
    )
    expect(resolveAttachmentLink('Projects/Plan.md', 'attachments/garden-budget.png', vault)).toBe(
      'attachments/garden-budget.png',
    )
  })

  it('percent-decodes and drops fragments like the index does', () => {
    const catalog = catalogOf('attachments/my photo.png')
    expect(resolveAttachmentLink('Home.md', 'attachments/my%20photo.png#frag', catalog)).toBe(
      'attachments/my photo.png',
    )
  })

  it("keeps Reflect's vault-root `assets/` reading before the catalog loads", () => {
    expect(resolveAttachmentLink('daily/2026-09-23.md', 'assets/pasted-1.png', null)).toBe(
      'assets/pasted-1.png',
    )
    expect(resolveAttachmentLink('notes/Plan.md', 'assets/pasted-2.png', vault)).toBe(
      'assets/pasted-2.png',
    )
  })

  it('finds a bare filename anywhere in the vault (Obsidian shortest path)', () => {
    expect(resolveAttachmentLink('Home.md', 'garden-budget.png', vault)).toBe(
      'attachments/garden-budget.png',
    )
    expect(resolveAttachmentLink('Home.md', 'garden-budget.png', null)).toBe('garden-budget.png')
  })

  it('breaks name ties by the note folder, then depth, then path order', () => {
    expect(resolveAttachmentLink('Projects/Plan.md', 'logo.png', vault)).toBe('Projects/logo.png')
    expect(resolveAttachmentLink('Home.md', 'logo.png', vault)).toBe('Archive/logo.png')
    expect(
      resolveAttachmentLink('Home.md', 'logo.png', catalogOf('a/b/logo.png', 'z/logo.png')),
    ).toBe('z/logo.png')
  })

  it('never searches by name for a destination with a folder or an explicit prefix', () => {
    expect(resolveAttachmentLink('Home.md', 'elsewhere/garden-budget.png', vault)).toBe(
      'elsewhere/garden-budget.png',
    )
    expect(resolveAttachmentLink('Projects/Plan.md', './garden-budget.png', vault)).toBe(
      'Projects/garden-budget.png',
    )
    // Normalized to the vault root, but still one authored place each.
    expect(resolveAttachmentLink('Home.md', './garden-budget.png', vault)).toBe('garden-budget.png')
    expect(resolveAttachmentLink('Home.md', '/garden-budget.png', vault)).toBe('garden-budget.png')
    expect(resolveAttachmentLink('Projects/Plan.md', '../garden-budget.png', vault)).toBe(
      'garden-budget.png',
    )
  })

  it('rejects URLs, notes, and traversal', () => {
    expect(resolveAttachmentLink('Home.md', 'https://example.com/a.png', vault)).toBeNull()
    expect(resolveAttachmentLink('Home.md', 'Deep Work.md', vault)).toBeNull()
    expect(resolveAttachmentLink('Home.md', '../outside.png', vault)).toBeNull()
    expect(resolveAttachmentLink('Home.md', '.obsidian/icon.png', vault)).toBeNull()
  })
})

describe('resolveWikiEmbedTarget', () => {
  it('hands out a bare target by name and a folder target from the vault root', () => {
    expect(resolveWikiEmbedTarget('garden-budget.png')).toEqual({
      kind: 'image',
      source: 'garden-budget.png',
    })
    expect(resolveWikiEmbedTarget('attachments/garden-budget.png')).toEqual({
      kind: 'image',
      source: '/attachments/garden-budget.png',
    })
  })

  it('encodes the source so it reads back as the same file', () => {
    expect(resolveWikiEmbedTarget('Media/my photo #1.png')).toEqual({
      kind: 'image',
      source: '/Media/my%20photo%20%231.png',
    })
    expect(resolveAttachmentLink('Home.md', '/Media/my%20photo%20%231.png', null)).toBe(
      'Media/my photo #1.png',
    )
  })

  it('renders non-image attachments as files and note targets as notes', () => {
    expect(resolveWikiEmbedTarget('report.pdf')).toEqual({ kind: 'file', source: 'report.pdf' })
    expect(resolveWikiEmbedTarget('Deep Work#Rules')).toEqual({ kind: 'note' })
    expect(resolveWikiEmbedTarget('Projects/Garden redesign')).toEqual({ kind: 'note' })
  })

  it('returns null for attachments at unsafe paths', () => {
    expect(resolveWikiEmbedTarget('../outside.png')).toBeNull()
    expect(resolveWikiEmbedTarget('.obsidian/icon.png')).toBeNull()
  })
})

describe('isImageAttachmentPath', () => {
  it('renders browser image formats inline, other attachments as files', () => {
    expect(isImageAttachmentPath('attachments/garden-budget.PNG')).toBe(true)
    expect(isImageAttachmentPath('a/diagram.svg')).toBe(true)
    expect(isImageAttachmentPath('attachments/report.pdf')).toBe(false)
    expect(isImageAttachmentPath('clip.mp4')).toBe(false)
  })
})

// The privacy gate decides from the index which notes reference a file. A
// note must never display a file the gate would not count as referenced by
// that note, or a private note could show an image the gate treats as public.
describe('agreement with the index privacy gate', () => {
  const links: readonly (readonly [source: string, destination: string])[] = [
    ['Projects/Garden redesign.md', '../attachments/garden-budget.png'],
    ['Home.md', 'attachments/garden-budget.png'],
    ['Projects/Plan.md', 'attachments/plan.png'],
    ['Projects/Plan.md', 'attachments/garden-budget.png'],
    ['Home.md', 'garden-budget.png'],
    ['Projects/Plan.md', 'logo.png'],
    ['Home.md', 'logo.png'],
    ['notes/Plan.md', 'assets/pasted-1.png'],
  ]
  const embeds: readonly (readonly [source: string, target: string])[] = [
    ['Home.md', 'garden-budget.png'],
    ['Projects/Plan.md', 'logo.png'],
    ['Home.md', 'attachments/report.pdf'],
    ['Home.md', 'missing.png'],
  ]

  function expectIndexed(source: string, body: string, resolved: string | null): void {
    expect(resolved).not.toBeNull()
    const references = parseNote({ path: source, source: `${body}\n` }).assets
    expect(references.some((ref) => assetReferenceMatches(ref.path, resolved ?? ''))).toBe(true)
  }

  for (const [source, destination] of links) {
    it(`indexes what ${source} displays for ![](${destination})`, () => {
      for (const catalog of [vault, catalogOf(), null]) {
        expectIndexed(
          source,
          `![img](${destination})`,
          resolveAttachmentLink(source, destination, catalog),
        )
      }
    })
  }

  for (const [source, target] of embeds) {
    it(`indexes what ${source} displays for ![[${target}]]`, () => {
      for (const catalog of [vault, catalogOf(), null]) {
        const embed = resolveWikiEmbedTarget(target)
        expectIndexed(
          source,
          `![[${target}]]`,
          embed?.kind === 'note'
            ? null
            : resolveAttachmentLink(source, embed?.source ?? '', catalog),
        )
      }
    })
  }
})
