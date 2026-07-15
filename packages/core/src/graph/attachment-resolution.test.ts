import { describe, expect, it } from 'vitest'
import type { FileMeta } from './schemas'
import {
  attachmentRenderKind,
  prepareAttachmentCatalog,
  resolveAttachmentFromCatalog,
  type AttachmentReference,
} from './attachment-resolution'

function file(path: string, placeholder = false): FileMeta {
  return { path, size: 1, modifiedMs: 1, ...(placeholder ? { placeholder: true } : {}) }
}

function resolve(
  reference: string,
  referenceKind: AttachmentReference['referenceKind'],
  catalog: readonly FileMeta[],
  sourcePath = 'Projects/Plan.md',
) {
  return resolveAttachmentFromCatalog({ sourcePath, reference, referenceKind }, catalog)
}

describe('resolveAttachmentFromCatalog', () => {
  it('resolves explicit relative, root, and URL-decoded Markdown paths', () => {
    const catalog = [
      file('Projects/images/local.png'),
      file('Shared/photo one.JPG'),
      file('Media/manual.pdf'),
    ]

    expect(resolve('./images/local.png', 'markdown', catalog)).toEqual({
      kind: 'resolved',
      path: 'Projects/images/local.png',
      renderKind: 'image',
    })
    expect(resolve('/Shared/photo%20one.JPG#preview', 'markdown', catalog)).toEqual({
      kind: 'resolved',
      path: 'Shared/photo one.JPG',
      renderKind: 'image',
    })
    expect(resolve('../Media/manual.pdf?download=1', 'markdown', catalog)).toEqual({
      kind: 'resolved',
      path: 'Media/manual.pdf',
      renderKind: 'file',
    })
    expect(resolve('.%2Fimages/local.png', 'markdown', catalog)).toEqual({
      kind: 'resolved',
      path: 'Projects/images/local.png',
      renderKind: 'image',
    })
    expect(resolve('%2FShared/photo%20one.JPG', 'markdown', catalog)).toEqual({
      kind: 'resolved',
      path: 'Shared/photo one.JPG',
      renderKind: 'image',
    })
  })

  it('reports an unqualified Markdown root/source collision instead of guessing', () => {
    const catalog = [file('Projects/photo.png'), file('photo.png')]

    expect(resolve('photo.png', 'markdown', catalog)).toEqual({
      kind: 'ambiguous',
      paths: ['Projects/photo.png', 'photo.png'],
    })
    expect(resolve('./photo.png', 'markdown', catalog)).toEqual({
      kind: 'resolved',
      path: 'Projects/photo.png',
      renderKind: 'image',
    })
    expect(resolve('/photo.png', 'markdown', catalog)).toEqual({
      kind: 'resolved',
      path: 'photo.png',
      renderKind: 'image',
    })
  })

  it('preserves legacy vault-root assets links from nested notes', () => {
    expect(resolve('assets/photo.png', 'markdown', [file('assets/photo.png')])).toEqual({
      kind: 'resolved',
      path: 'assets/photo.png',
      renderKind: 'image',
    })
  })

  it('resolves bare wiki embeds by unique case-insensitive filename', () => {
    const catalog = [file('Media/PHOTO.PNG')]

    expect(resolve('photo.png', 'wikiEmbed', catalog)).toEqual({
      kind: 'resolved',
      path: 'Media/PHOTO.PNG',
      renderKind: 'image',
    })
    expect(resolve('Media/PHOTO.PNG', 'wikiEmbed', catalog)).toEqual({
      kind: 'resolved',
      path: 'Media/PHOTO.PNG',
      renderKind: 'image',
    })
    expect(resolve('Media%2FPHOTO.PNG', 'wikiEmbed', catalog)).toEqual({
      kind: 'resolved',
      path: 'Media/PHOTO.PNG',
      renderKind: 'image',
    })
  })

  it('reports duplicate wiki filenames in stable path order', () => {
    const catalog = [file('Other/photo.png'), file('Media/PHOTO.PNG')]

    expect(resolve('photo.png', 'wikiEmbed', catalog)).toEqual({
      kind: 'ambiguous',
      paths: ['Media/PHOTO.PNG', 'Other/photo.png'],
    })
  })

  it('distinguishes unavailable placeholders from missing attachments', () => {
    expect(resolve('remote.png', 'wikiEmbed', [file('Media/remote.png', true)])).toEqual({
      kind: 'unavailable',
      path: 'Media/remote.png',
    })
    expect(resolve('missing.png', 'wikiEmbed', [])).toEqual({ kind: 'notFound' })
  })

  it('keeps an available/placeholder collision ambiguous', () => {
    const catalog = [file('Projects/photo.png', true), file('photo.png')]

    expect(resolve('photo.png', 'markdown', catalog)).toEqual({
      kind: 'ambiguous',
      paths: ['Projects/photo.png', 'photo.png'],
    })
  })

  it('rejects traversal, hidden paths, malformed URLs, and unsupported formats', () => {
    for (const reference of [
      '../../outside.png',
      '%2e%2e/%2e%2e/outside.png',
      '../.hidden/photo.png',
      'folder\\photo.png',
      '//server/photo.png',
      'https%3Aphoto.png',
      'C%3A/folder/photo.png',
      'bad%ZZ.png',
      'payload.html',
    ]) {
      expect(resolve(reference, 'markdown', [])).toEqual({ kind: 'invalid' })
    }

    expect(
      resolveAttachmentFromCatalog(
        {
          sourcePath: '.private/Plan.md',
          reference: 'photo.png',
          referenceKind: 'markdown',
        },
        [file('photo.png')],
      ),
    ).toEqual({ kind: 'invalid' })
  })

  it('ignores unsafe or unsupported catalog entries', () => {
    const catalog = [
      file('.obsidian/photo.png'),
      file('Media/.photo.png'),
      file('../photo.png'),
      file('Media/photo.html'),
    ]

    expect(resolve('photo.png', 'wikiEmbed', catalog)).toEqual({ kind: 'notFound' })
  })

  it('supports the Obsidian attachment extension set case-insensitively', () => {
    const extensions = [
      '3gp',
      'avif',
      'bmp',
      'flac',
      'gif',
      'jpeg',
      'jpg',
      'm4a',
      'mkv',
      'mov',
      'mp3',
      'mp4',
      'ogg',
      'ogv',
      'pdf',
      'png',
      'svg',
      'wav',
      'webm',
      'webp',
    ]

    for (const extension of extensions) {
      const path = `Media/file.${extension.toUpperCase()}`
      expect(resolve(path, 'wikiEmbed', [file(path)])).not.toEqual({ kind: 'invalid' })
    }
  })

  it('does not manufacture ambiguity when the source note is at the root', () => {
    expect(resolve('photo.png', 'markdown', [file('photo.png')], 'Plan.md')).toEqual({
      kind: 'resolved',
      path: 'photo.png',
      renderKind: 'image',
    })
  })
})

describe('attachmentRenderKind', () => {
  it('classifies supported image and file placeholders', () => {
    expect(attachmentRenderKind('Media/photo.AVIF')).toBe('image')
    expect(attachmentRenderKind('Media/vector.svg')).toBe('image')
    expect(attachmentRenderKind('Media/recording.MP4')).toBe('file')
    expect(attachmentRenderKind('Media/manual.pdf')).toBe('file')
  })

  it('fails closed for unsafe and unsupported paths', () => {
    expect(attachmentRenderKind('../photo.png')).toBeNull()
    expect(attachmentRenderKind('.private/photo.png')).toBeNull()
    expect(attachmentRenderKind('Media/page.html')).toBeNull()
  })
})

describe('prepareAttachmentCatalog', () => {
  it('reuses path/basename indexes and exposes current metadata', () => {
    const source = [file('Media/photo.png'), { ...file('Media/manual.pdf'), size: 42 }]
    const catalog = prepareAttachmentCatalog(source)

    expect(
      catalog.resolve({
        sourcePath: 'Projects/Plan.md',
        reference: 'photo.png',
        referenceKind: 'wikiEmbed',
      }),
    ).toEqual({ kind: 'resolved', path: 'Media/photo.png', renderKind: 'image' })
    expect(catalog.metadataForPath('Media/manual.pdf')?.size).toBe(42)

    // Preparing takes a snapshot: later mutation of the caller's manifest
    // cannot silently alter a resolver already mounted in an editor.
    source.push(file('Other/PHOTO.PNG'))
    expect(
      catalog.resolve({
        sourcePath: 'Projects/Plan.md',
        reference: 'photo.png',
        referenceKind: 'wikiEmbed',
      }),
    ).toEqual({ kind: 'resolved', path: 'Media/photo.png', renderKind: 'image' })
  })
})
