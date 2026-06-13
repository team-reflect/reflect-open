import { z } from 'zod'
import { ReflectError } from '../errors'
import { apiHeaders, readJson } from './github'

/**
 * The GitHub Gists REST surface behind "Publish to gist": create a secret
 * gist, update it in place on republish. Same conventions as the repo module
 * — injected `fetchFn`, zod-validated responses, `ReflectError` kinds.
 *
 * Gists need the GitHub App's **Gists** user permission (or a PAT with gist
 * access); GitHub deliberately answers **404** — not 403 — when a token lacks
 * it, so a 404 from *create* maps to a reconnect-and-grant message. A 404
 * from *update* stays ambiguous (the gist may simply have been deleted on
 * github.com), so it returns `null` and the caller falls back to creating a
 * fresh gist — which then settles which 404 it was.
 */

type FetchFn = typeof fetch

/** A published gist, as the publish flow records it. */
export interface PublishedGist {
  id: string
  /** The gist page url — what publishing copies to the clipboard. */
  htmlUrl: string
}

const gistResponseSchema = z.object({
  id: z.string(),
  html_url: z.string(),
})

function toPublished(parsed: z.infer<typeof gistResponseSchema>): PublishedGist {
  return { id: parsed.id, htmlUrl: parsed.html_url }
}

/** What one publish sends: the gist filename and the note body it carries. */
export interface GistContent {
  filename: string
  content: string
}

/**
 * Create a **secret** gist holding `content`. Secret is not negotiable here:
 * the share flow is copy-the-link, and a public gist would also list on the
 * user's profile feed.
 */
export async function createGist(
  token: string,
  content: GistContent,
  fetchFn: FetchFn = fetch,
): Promise<PublishedGist> {
  const response = await fetchFn('https://api.github.com/gists', {
    method: 'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      public: false,
      files: { [content.filename]: { content: content.content } },
    }),
  })
  if (response.status === 404) {
    throw new ReflectError(
      'auth',
      'GitHub refused gist access (404) — reconnect GitHub to grant it',
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw new ReflectError('auth', `GitHub rejected the token (${response.status})`)
  }
  if (!response.ok) {
    const body = await response.text()
    throw new ReflectError('io', `creating the gist failed (${response.status}): ${body}`)
  }
  return toPublished(await readJson(response, gistResponseSchema, 'gist creation'))
}

/**
 * Update an existing gist in place. `previousFilename` is the name the body
 * was last published under (from the `gist` frontmatter block): PATCH keys
 * files by their *current* name, so addressing the old name and setting
 * `filename` renames on a title change instead of adding a second file —
 * and never touches files the user added to the gist by hand. Returns `null`
 * when the gist is gone (deleted on github.com, or gist access was revoked);
 * the caller falls back to {@link createGist}.
 */
export async function updateGist(
  token: string,
  gistId: string,
  previousFilename: string,
  content: GistContent,
  fetchFn: FetchFn = fetch,
): Promise<PublishedGist | null> {
  const response = await fetchFn(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: { [previousFilename]: { filename: content.filename, content: content.content } },
    }),
  })
  if (response.status === 404) {
    return null
  }
  if (response.status === 401 || response.status === 403) {
    throw new ReflectError('auth', `GitHub rejected the token (${response.status})`)
  }
  if (!response.ok) {
    const body = await response.text()
    throw new ReflectError('io', `updating the gist failed (${response.status}): ${body}`)
  }
  return toPublished(await readJson(response, gistResponseSchema, 'gist update'))
}
