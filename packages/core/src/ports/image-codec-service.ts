import type { MaybePromise } from '@reflect/utils'
/**
 * Options for {@link DecodedImage.encode}.
 */
export interface ImageEncodeOptions {
  /**
   * The output MIME type, e.g. `image/jpeg`.
   */
  type: string
  /**
   * Lossy quality between 0 and 1.
   */
  quality: number
  /**
   * The output width; the decoded width when absent.
   */
  width?: number
  /**
   * The output height; the decoded height when absent.
   */
  height?: number
}

/**
 * A decoded image. Call {@link close} once done with it.
 */
export interface DecodedImage {
  readonly width: number
  readonly height: number
  /**
   * Re-encode the image, scaled to the requested size; `null` when encoding fails.
   */
  encode(options: ImageEncodeOptions): MaybePromise<Blob | null>
  close(): void
}

/**
 * Decodes and re-encodes image files.
 */
export interface ImageCodecService {
  /**
   * Decode `file`; `null` when this surface has no decoder or the file is undecodable.
   */
  decode(file: Blob): MaybePromise<DecodedImage | null>
}

class UnavailableImageCodecImpl implements ImageCodecService {
  async decode(_file: Blob): Promise<DecodedImage | null> {
    return null
  }
}

/**
 * An {@link ImageCodecService} with no decoder: every `decode` resolves `null`.
 */
export function createUnavailableImageCodec(): ImageCodecService {
  return new UnavailableImageCodecImpl()
}
