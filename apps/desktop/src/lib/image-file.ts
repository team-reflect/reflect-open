/** JPEG quality for a transcoded photo: visually lossless at a sane size. */
const JPEG_QUALITY = 0.92

/** True for the format an iPhone's photo library hands over for camera shots. */
function isAppleImageFormat(file: File): boolean {
  const type = file.type.toLowerCase()
  return type === 'image/heic' || type === 'image/heif' || /\.hei[cf]$/i.test(file.name)
}

/** `photo.heic` → `photo.jpg`; a name without an extension just gains one. */
function withJpegExtension(name: string): string {
  const separator = name.lastIndexOf('.')
  return `${separator === -1 ? name : name.slice(0, separator)}.jpg`
}

/**
 * Re-encode a HEIC/HEIF pick as JPEG, or return the file untouched.
 *
 * The iOS photo library hands over the camera's native format, and a `.heic`
 * written into the graph is a file GitHub, Obsidian, and every non-Apple
 * viewer refuse to render — the vault is meant to outlive this app on any
 * platform. Every other format passes through byte for byte: a note asset is
 * the user's own photo, not a payload to shrink (an oversized one still gets
 * the large-file warning every save gets).
 *
 * Falls back to the original file when the webview has no decoder for it,
 * which is the honest outcome: the photo lands in the note either way, and
 * the format question surfaces where it can be seen.
 */
export async function toPortableImageFile(file: File): Promise<File> {
  if (!isAppleImageFormat(file) || typeof createImageBitmap !== 'function') {
    return file
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file
  }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (context === null) {
      return file
    }
    context.drawImage(bitmap, 0, 0)
    const encoded = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
    })
    if (encoded === null) {
      return file
    }
    return new File([encoded], withJpegExtension(file.name), { type: 'image/jpeg' })
  } finally {
    bitmap.close()
  }
}
