import { describe, expect, it } from 'vitest'
import { createBrowserImageCodec } from './browser-image-codec.ts'

/**
 * A decodable 4×2 PNG.
 */
async function pngFile(): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 2
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png')
  })
  return new File([blob!], 'image.png', { type: 'image/png' })
}

describe('createBrowserImageCodec', () => {
  it('decodes an image and re-encodes it as JPEG', async () => {
    const image = await createBrowserImageCodec().decode(await pngFile())
    expect(image).not.toBeNull()
    expect([image!.width, image!.height]).toEqual([4, 2])

    const encoded = await image!.encode({ type: 'image/jpeg', quality: 0.9, width: 2, height: 1 })
    image!.close()

    expect(encoded?.type).toBe('image/jpeg')
    expect(encoded?.size).toBeGreaterThan(0)
  })

  it('answers null for an undecodable file', async () => {
    const file = new File(['not an image'], 'broken.heic', { type: 'image/heic' })
    expect(await createBrowserImageCodec().decode(file)).toBeNull()
  })
})
