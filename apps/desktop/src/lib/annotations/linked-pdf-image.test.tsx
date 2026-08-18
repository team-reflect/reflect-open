import { describe, expect, it } from 'vitest'
import {
  linkedPdfImageCaption,
  linkedPdfImageHitAt,
  linkedPdfImageSource,
} from './linked-pdf-image'

/**
 * meowdown's rendered shape for `[![alt](img)](assets/paper.pdf#page=N)`: the
 * link pack holds the source anchor (covering only the `[` mark and the
 * hidden source) beside the image view — the `<img>` is never inside an
 * anchor.
 */
function linkedImage(href: string): HTMLElement {
  const pack = document.createElement('span')
  pack.className = 'md-pack'
  pack.dataset.key = 'link'
  const sourceAnchor = document.createElement('a')
  sourceAnchor.className = 'md-link'
  sourceAnchor.setAttribute('href', href)
  sourceAnchor.textContent = '['
  const view = document.createElement('span')
  view.className = 'md-image-view'
  const preview = document.createElement('span')
  preview.className = 'md-image-view-preview'
  const image = document.createElement('img')
  image.setAttribute('alt', 'shot')
  preview.append(image)
  const content = document.createElement('span')
  content.className = 'md-image-view-content'
  const contentAnchor = document.createElement('a')
  contentAnchor.className = 'md-link'
  contentAnchor.setAttribute('href', href)
  contentAnchor.textContent = '![shot](assets/shot.png)'
  content.append(contentAnchor)
  view.append(preview, content)
  pack.append(sourceAnchor, view)
  document.body.append(pack)
  return image
}

function plainImage(): HTMLElement {
  const view = document.createElement('span')
  view.className = 'md-image-view'
  const preview = document.createElement('span')
  preview.className = 'md-image-view-preview'
  const image = document.createElement('img')
  preview.append(image)
  view.append(preview)
  document.body.append(view)
  return image
}

describe('linkedPdfImageHitAt', () => {
  it('parses an image inside a PDF page link from the real meowdown DOM', () => {
    const image = linkedImage('assets/paper.pdf#page=3')
    const hit = linkedPdfImageHitAt(image)
    expect(hit?.ref).toEqual({ path: 'assets/paper.pdf', page: 3 })
    expect(hit?.view.classList.contains('md-image-view')).toBe(true)
  })

  it('returns null for a plain image and for a non-PDF link target', () => {
    expect(linkedPdfImageHitAt(plainImage())).toBeNull()
    expect(linkedPdfImageHitAt(linkedImage('assets/notes.docx'))).toBeNull()
    expect(linkedPdfImageHitAt(linkedImage('https://example.com/paper.pdf'))).toBeNull()
  })

  it('returns null outside an image view', () => {
    const anchor = document.createElement('a')
    anchor.setAttribute('href', 'assets/paper.pdf#page=2')
    document.body.append(anchor)
    expect(linkedPdfImageHitAt(anchor)).toBeNull()
  })

  it('matches the anchor-wrapped shape of non-meowdown renderings', () => {
    const anchor = document.createElement('a')
    anchor.setAttribute('href', 'assets/paper.pdf#page=2')
    const view = document.createElement('span')
    view.className = 'md-image-view'
    const image = document.createElement('img')
    view.append(image)
    anchor.append(view)
    document.body.append(anchor)
    expect(linkedPdfImageHitAt(image)?.ref).toEqual({ path: 'assets/paper.pdf', page: 2 })
  })
})

describe('linkedPdfImageSource', () => {
  it('reads the markdown image src back from the hidden source', () => {
    const image = linkedImage('assets/paper.pdf#page=3')
    const hit = linkedPdfImageHitAt(image)
    expect(hit !== null && linkedPdfImageSource(hit)).toBe('assets/shot.png')
  })
})

describe('linkedPdfImageCaption', () => {
  it('names the PDF without its extension, plus the page', () => {
    expect(linkedPdfImageCaption({ path: 'assets/A Tour of C++.pdf', page: 37 })).toBe(
      'A Tour of C++ - p37',
    )
    expect(linkedPdfImageCaption({ path: 'assets/paper.pdf' })).toBe('paper')
  })
})
