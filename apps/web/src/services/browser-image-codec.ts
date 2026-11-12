import type { DecodedImage, ImageCodecService } from '@reflect/core'

class BrowserDecodedImage implements DecodedImage {
  readonly #bitmap: ImageBitmap
  readonly width: number
  readonly height: number

  constructor(bitmap: ImageBitmap) {
    this.#bitmap = bitmap
    this.width = bitmap.width
    this.height = bitmap.height
  }

  async encode(options: Parameters<DecodedImage['encode']>[0]): Promise<Blob | null> {
    const bitmap = this.#bitmap
    const canvas = document.createElement('canvas')
    canvas.width = options.width ?? bitmap.width
    canvas.height = options.height ?? bitmap.height
    const context = canvas.getContext('2d')
    if (context === null) {
      return null
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, options.type, options.quality)
    })
  }

  close(): void {
    this.#bitmap.close()
  }
}

/**
 * An {@link ImageCodecService} over `createImageBitmap` and a `<canvas>`.
 */
export function createBrowserImageCodec(): ImageCodecService {
  return {
    async decode(file) {
      if (typeof createImageBitmap !== 'function') {
        return null
      }
      let bitmap: ImageBitmap
      try {
        bitmap = await createImageBitmap(file)
      } catch {
        return null
      }
      return new BrowserDecodedImage(bitmap)
    },
  }
}
