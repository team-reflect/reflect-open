import { describe, expect, it } from 'vitest'
import { annotationScreenshotReference, regionRenderSpec } from './pdf-region-screenshot'

describe('regionRenderSpec', () => {
  it('maps a normalized rect to a 2x device-pixel canvas with a page offset', () => {
    const spec = regionRenderSpec([0.2, 0.1, 0.6, 0.4], 300, 200, 2)
    expect(spec).toEqual({
      width: 240,
      height: 120,
      scale: 2,
      offsetX: -120,
      offsetY: -40,
    })
  })

  it('clamps degenerate rects to a one-pixel canvas', () => {
    const spec = regionRenderSpec([0.5, 0.5, 0.5, 0.5], 300, 200, 2)
    expect(spec.width).toBeGreaterThanOrEqual(1)
    expect(spec.height).toBeGreaterThanOrEqual(1)
  })
})

describe('annotationScreenshotReference', () => {
  it('wraps the saved screenshot in a link back to the PDF page', () => {
    expect(annotationScreenshotReference('assets/paper.pdf', 3, 'assets/pasted-123.png')).toBe(
      '[![pasted-123.png](assets/pasted-123.png)](assets/paper.pdf#page=3)',
    )
  })

  it('URL-encodes the PDF path per segment so spaces and # cannot break it', () => {
    expect(
      annotationScreenshotReference('assets/a#b dir/paper.pdf', 2, 'assets/pasted-1.png'),
    ).toBe('[![pasted-1.png](assets/pasted-1.png)](assets/a%23b%20dir/paper.pdf#page=2)')
  })
})
