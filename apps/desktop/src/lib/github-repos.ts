import { parseGithubRemote, type GithubRepoRef } from '@reflect/core'

/**
 * Parse what a user types into a "which repository" field — `owner/name` or a
 * full GitHub URL — into a repo ref; `null` when it's neither.
 */
export function parseRepoInput(input: string): GithubRepoRef | null {
  const trimmed = input.trim()
  const fromUrl = parseGithubRemote(trimmed)
  if (fromUrl !== null) {
    return fromUrl
  }
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed)
  return match === null ? null : { owner: match[1], name: match[2] }
}

/**
 * A backup-repo name suggestion from the graph name: "Alex Notes" →
 * "alex-notes-backup"; a generic fallback when the name slugs away to nothing.
 */
export function suggestRepoName(graphName: string | undefined): string {
  const slug = (graphName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? `${slug}-backup` : 'reflect-backup'
}
