import type {
  DecodedImage,
  ImageCodecService,
  ImageEncodeOptions,
} from '../ports/image-codec-service.ts'

export interface TestImageSize {
  readonly width: number
  readonly height: number
}

export interface TestImageEncode {
  readonly file: Blob
  readonly type: string
  readonly quality: number
  readonly width: number
  readonly height: number
}

export interface TestImageCodecService extends ImageCodecService {
  decodedFiles(): readonly Blob[]
  encodes(): readonly TestImageEncode[]
  /**
   * The number of decoded images not yet closed.
   */
  openImages(): number
  /**
   * Make later encodes resolve `null`; `false` makes them succeed again.
   */
  failEncodes(fail: boolean): void
}

interface TestDecodedImageHost {
  isFailing(): boolean
  recordEncode(encode: TestImageEncode): void
  releaseImage(): void
}

class TestDecodedImage implements DecodedImage {
  readonly #file: Blob
  readonly #host: TestDecodedImageHost
  #closed = false

  readonly width: number
  readonly height: number

  constructor(file: Blob, dimensions: TestImageSize, host: TestDecodedImageHost) {
    this.#file = file
    this.#host = host
    this.width = dimensions.width
    this.height = dimensions.height
  }

  encode(options: ImageEncodeOptions): Promise<Blob | null> {
    return Promise.try(() => {
      if (this.#host.isFailing()) {
        return null
      }
      const width = options.width ?? this.width
      const height = options.height ?? this.height
      this.#host.recordEncode({
        file: this.#file,
        type: options.type,
        quality: options.quality,
        width,
        height,
      })
      return new Blob([`encoded ${width}x${height}`], { type: options.type })
    })
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true
      this.#host.releaseImage()
    }
  }
}

class TestImageCodecServiceImpl implements TestImageCodecService {
  readonly #size: (file: Blob) => TestImageSize | null
  readonly #decoded: Blob[] = []
  readonly #encoded: TestImageEncode[] = []
  readonly #host: TestDecodedImageHost
  #open = 0
  #failing = false

  constructor(size: (file: Blob) => TestImageSize | null) {
    this.#size = size
    this.#host = {
      isFailing: () => this.#failing,
      recordEncode: (encode) => {
        this.#encoded.push(encode)
      },
      releaseImage: () => {
        this.#open -= 1
      },
    }
  }

  decode(file: Blob): Promise<DecodedImage | null> {
    return Promise.try(() => {
      const dimensions = this.#size(file)
      if (dimensions === null) {
        return null
      }
      this.#decoded.push(file)
      this.#open += 1
      return new TestDecodedImage(file, dimensions, this.#host)
    })
  }

  decodedFiles(): readonly Blob[] {
    return [...this.#decoded]
  }

  encodes(): readonly TestImageEncode[] {
    return [...this.#encoded]
  }

  openImages(): number {
    return this.#open
  }

  failEncodes(fail: boolean): void {
    this.#failing = fail
  }
}

/**
 * An {@link ImageCodecService} that decodes without reading pixels. `size`
 * gives each file's dimensions, or `null` for an undecodable file. By default
 * every `image/*` blob decodes as 1×1. An encode resolves a blob of the
 * requested type whose text is `encoded <width>x<height>`.
 */
export function createTestImageCodec(options?: {
  size?: (file: Blob) => TestImageSize | null
}): TestImageCodecService {
  return new TestImageCodecServiceImpl(
    options?.size ??
      ((file: Blob): TestImageSize | null => {
        return file.type.startsWith('image/') ? { width: 1, height: 1 } : null
      }),
  )
}
