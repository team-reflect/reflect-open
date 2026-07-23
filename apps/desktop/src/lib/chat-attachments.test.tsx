import { afterEach, describe, expect, it, vi } from 'vitest'
import { toChatAttachment } from '@/lib/chat-attachments'

/**
 * The downscale gate over a stubbed decoder (jsdom has neither
 * `createImageBitmap` nor a canvas rasterizer): oversized or non-provider-safe
 * images re-encode to a bounded JPEG, small safe ones pass through untouched,
 * and an undecodable file falls back to its original bytes.
 */

interface FakeBitmap {
  width: number
  height: number
  close: () => void
}

const drawImage = vi.fn<(bitmap: FakeBitmap, x: number, y: number, w: number, h: number) => void>()

function stubDecoder(bitmap: FakeBitmap | null): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      if (bitmap === null) {
        throw new Error('undecodable')
      }
      return bitmap
    }),
  )
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ drawImage })
  HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,SCALED')
}

function imageFile(type: string): File {
  return new File([new Uint8Array([0x89, 0x50])], 'photo', { type })
}

afterEach(() => {
  vi.unstubAllGlobals()
  drawImage.mockReset()
})

describe('toChatAttachment', () => {
  it('re-encodes an oversized image to a JPEG within the long-edge cap', async () => {
    const close = vi.fn()
    stubDecoder({ width: 4000, height: 2000, close })

    const attachment = await toChatAttachment(imageFile('image/jpeg'))

    expect(attachment.mediaType).toBe('image/jpeg')
    expect(attachment.dataUrl).toBe('data:image/jpeg;base64,SCALED')
    // 4000×2000 scaled by 1568/4000 → 1568×784.
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1568, 784)
    expect(close).toHaveBeenCalled()
  })

  it('passes a small provider-safe image through with its original bytes', async () => {
    stubDecoder({ width: 100, height: 50, close: vi.fn() })

    const attachment = await toChatAttachment(imageFile('image/png'))

    expect(attachment.mediaType).toBe('image/png')
    expect(attachment.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(drawImage).not.toHaveBeenCalled()
  })

  it('transcodes a small non-provider-safe format (HEIC) to JPEG', async () => {
    stubDecoder({ width: 100, height: 50, close: vi.fn() })

    const attachment = await toChatAttachment(imageFile('image/heic'))

    expect(attachment.mediaType).toBe('image/jpeg')
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 100, 50)
  })

  it('falls back to the original bytes when the file cannot be decoded', async () => {
    stubDecoder(null)

    const attachment = await toChatAttachment(imageFile('image/tiff'))

    expect(attachment.mediaType).toBe('image/tiff')
    expect(attachment.dataUrl.startsWith('data:image/tiff;base64,')).toBe(true)
  })
})
