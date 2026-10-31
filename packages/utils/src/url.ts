/**
 * `new URL(url)`, or null when the string is not an absolute URL. The
 * platform throws on malformed input; callers that treat a bad URL as an
 * ordinary outcome want a null instead.
 */
export function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
