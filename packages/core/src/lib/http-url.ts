export function normalizeOpenAICompatibleBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '')
}

export function isHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(normalizeOpenAICompatibleBaseUrl(value))
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}
