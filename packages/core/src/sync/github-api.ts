import type { z } from 'zod'
import { ReflectError } from '../errors'

export type FetchFn = typeof fetch

export const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' }

/**
 * Read and validate a JSON response body. A body that isn't JSON at all (an
 * HTML error page from a proxy or an overloaded GitHub) means the request
 * never got a real protocol answer — `network`, so it stays retryable and is
 * never mistaken for a dead credential. A JSON body the schema rejects is an
 * API contract change — `parse`.
 */
export async function readJson<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
  what: string,
): Promise<z.infer<Schema>> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ReflectError(
      'network',
      `${what}: GitHub returned an unreadable response (${response.status})`,
    )
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new ReflectError(
      'parse',
      `${what}: GitHub returned an unexpected response shape (${response.status})`,
    )
  }
  return parsed.data
}

/** Standard `api.github.com` request headers (shared with the gists module). */
export function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
}
