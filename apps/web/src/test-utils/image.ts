/**
 * A data URL for a blank SVG image of the given size. It loads without the
 * network, so tests get an image with real dimensions and no load delay.
 */
export function getSvgImageUrl(width: number, height: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}
