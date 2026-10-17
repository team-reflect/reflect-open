import { z } from 'zod'
import type { HttpService } from '../ports/http-service.ts'
import { AppError } from '../errors.ts'
import { apiHeaders, readJson } from './github-api.ts'

/**
 * A published gist, as the publish flow records it.
 */
export interface PublishedGist {
  id: string
  /**
   * The gist page url — what publishing copies to the clipboard.
   */
  htmlUrl: string
}

const gistResponseSchema = z.object({
  id: z.string(),
  html_url: z.string(),
})

function toPublished(parsed: z.infer<typeof gistResponseSchema>): PublishedGist {
  return { id: parsed.id, htmlUrl: parsed.html_url }
}

/**
 * What one publish sends: the gist filename and the note body it carries.
 */
export interface GistFile {
  name: string
  content: string
}

/**
 * The GitHub Gists REST surface behind "Publish to gist": create a secret
 * gist, update it in place on republish. Same conventions as the repo service
 * — zod-validated responses, `AppError` kinds.
 *
 * Gists need the GitHub App's **Gists** user permission (or a PAT with gist
 * access); GitHub deliberately answers **404** — not 403 — when a token lacks
 * it, so a 404 from *create* maps to a reconnect-and-grant message. A 404
 * from *update* stays ambiguous (the gist may simply have been deleted on
 * github.com), so it returns `null` and the caller falls back to creating a
 * fresh gist — which then settles which 404 it was.
 */
export interface GistService {
  /**
   * Create a **secret** gist holding `file`. Secret is not negotiable here:
   * the share flow is copy-the-link, and a public gist would also list on the
   * user's profile feed.
   */
  create(token: string, file: GistFile): Promise<PublishedGist>
  /**
   * Update an existing gist in place. `previousFilename` is the name the body
   * was last published under (from the `gist` frontmatter block): PATCH keys
   * files by their *current* name, so addressing the old name and setting
   * `filename` renames on a title change instead of adding a second file —
   * and never touches files the user added to the gist by hand. Returns `null`
   * when the gist is gone (deleted on github.com, or gist access was revoked);
   * the caller falls back to {@link GistService.create}.
   */
  update(
    token: string,
    gistId: string,
    previousFilename: string,
    file: GistFile,
  ): Promise<PublishedGist | null>
  /**
   * Delete a gist. The publish flow's compensating action: a gist created
   * moments ago whose local frontmatter record then failed to land would be
   * orphaned on GitHub — and re-created on the next publish. A 404 counts as
   * success (already gone is the goal state).
   */
  delete(token: string, gistId: string): Promise<void>
}

export interface GistServiceDeps {
  readonly http: HttpService
}

class GistServiceImpl implements GistService {
  readonly #deps: GistServiceDeps

  constructor(deps: GistServiceDeps) {
    this.#deps = deps
  }

  async create(token: string, file: GistFile): Promise<PublishedGist> {
    const { http } = this.#deps
    const response = await http.fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public: false,
        files: { [file.name]: { content: file.content } },
      }),
    })
    if (response.status === 404) {
      throw new AppError('auth', 'GitHub refused gist access (404) — reconnect GitHub to grant it')
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError('auth', `GitHub rejected the token (${response.status})`)
    }
    if (!response.ok) {
      const body = await response.text()
      throw new AppError('io', `creating the gist failed (${response.status}): ${body}`)
    }
    return toPublished(await readJson(response, gistResponseSchema, 'gist creation'))
  }

  async update(
    token: string,
    gistId: string,
    previousFilename: string,
    file: GistFile,
  ): Promise<PublishedGist | null> {
    const { http } = this.#deps
    const response = await http.fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: { [previousFilename]: { filename: file.name, content: file.content } },
      }),
    })
    if (response.status === 404) {
      return null
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError('auth', `GitHub rejected the token (${response.status})`)
    }
    if (!response.ok) {
      const body = await response.text()
      throw new AppError('io', `updating the gist failed (${response.status}): ${body}`)
    }
    return toPublished(await readJson(response, gistResponseSchema, 'gist update'))
  }

  async delete(token: string, gistId: string): Promise<void> {
    const { http } = this.#deps
    const response = await http.fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'DELETE',
      headers: apiHeaders(token),
    })
    if (response.status === 404 || response.ok) {
      return
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError('auth', `GitHub rejected the token (${response.status})`)
    }
    throw new AppError('io', `deleting the gist failed (${response.status})`)
  }
}

export function createGistService(deps: GistServiceDeps): GistService {
  return new GistServiceImpl(deps)
}
