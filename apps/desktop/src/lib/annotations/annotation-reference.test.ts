import { describe, expect, it } from 'vitest'
import { annotationReference } from './annotation-reference'
import type { AnnotationItem } from './annotations-store'

function item(partial: Partial<AnnotationItem>): AnnotationItem {
  return {
    id: 'a1',
    pageIndex: 0,
    type: 'border',
    rects: [[0.1, 0.1, 0.2, 0.2]],
    color: '#FFD400',
    text: 'A key claim',
    ...partial,
  }
}

describe('annotationReference', () => {
  it('builds a pdf link with the 1-based page and the annotation text', () => {
    expect(annotationReference('assets/papers/paper.pdf', item({ pageIndex: 2 }))).toBe(
      '[paper - p3 - A key claim](assets/papers/paper.pdf#page=3)',
    )
  })

  it('drops the text suffix when the annotation carries none', () => {
    expect(annotationReference('assets/paper.pdf', item({ text: '' }))).toBe(
      '[paper - p1](assets/paper.pdf#page=1)',
    )
  })

  it('ignores surrounding whitespace in the text check', () => {
    expect(annotationReference('assets/paper.pdf', item({ text: '   ' }))).toBe(
      '[paper - p1](assets/paper.pdf#page=1)',
    )
  })

  it('derives the filename without the .pdf extension, preserving folders', () => {
    expect(annotationReference('assets/sub dir/report.PDF', item({ text: '' }))).toBe(
      '[report - p1](assets/sub%20dir/report.PDF#page=1)',
    )
  })

  it('percent-encodes the asset path so the link parses in markdown', () => {
    expect(
      annotationReference(
        'assets/A Tour of C++ 2nd Edition In-Depth Series-20221006164454-p9l6vxe.pdf',
        item({ pageIndex: 14 }),
      ),
    ).toBe(
      '[A Tour of C++ 2nd Edition In-Depth Series-20221006164454-p9l6vxe - p15 - A key claim](assets/A%20Tour%20of%20C%2B%2B%202nd%20Edition%20In-Depth%20Series-20221006164454-p9l6vxe.pdf#page=15)',
    )
  })

  it('encodes # ? and parens per segment so the fragment stays the page target', () => {
    expect(annotationReference('assets/a#b?c(d).pdf', item({ text: '' }))).toBe(
      '[a#b?c(d) - p1](assets/a%23b%3Fc%28d%29.pdf#page=1)',
    )
  })

  it('escapes brackets and collapses whitespace in the link label', () => {
    expect(annotationReference('assets/paper.pdf', item({ text: 'claims [x] and\ny]' }))).toBe(
      String.raw`[paper - p1 - claims \[x\] and y\]](assets/paper.pdf#page=1)`,
    )
  })
})
