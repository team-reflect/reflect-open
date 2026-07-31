import { describe, expect, it } from 'vitest'
import { toPortableImageFile } from './image-file'

/** A decodable image, wrapped under whatever name and type the test needs. */
async function imageFile(name: string, type: string): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 2
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png')
  })
  return new File([blob!], name, { type })
}

describe('toPortableImageFile', () => {
  it('transcodes a HEIC pick to JPEG', async () => {
    const picked = await imageFile('photo.heic', 'image/heic')
    const portable = await toPortableImageFile(picked)

    expect(portable.name).toBe('photo.jpg')
    expect(portable.type).toBe('image/jpeg')
    expect(portable.size).toBeGreaterThan(0)
  })

  it('recognizes HEIF by filename when the pick carries no type', async () => {
    const picked = await imageFile('IMG_0001.HEIF', '')
    expect((await toPortableImageFile(picked)).name).toBe('IMG_0001.jpg')
  })

  it('passes every other format through untouched', async () => {
    const picked = await imageFile('screenshot.png', 'image/png')
    expect(await toPortableImageFile(picked)).toBe(picked)
  })

  it('keeps the original when the webview cannot decode it', async () => {
    const picked = new File(['not an image'], 'broken.heic', { type: 'image/heic' })
    expect(await toPortableImageFile(picked)).toBe(picked)
  })
})
