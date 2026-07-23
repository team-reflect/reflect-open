import { resolveOrCreateNoteWithTitle, type ResolveOrCreateNoteResult } from '../graph/create-note'
import { db } from '../indexing/db'
import { getWikiAddressForPath } from '../indexing/queries-suggestions'
import { inClauseChunks } from '../indexing/query-utils'
import { canonicalEmails } from '../markdown/email-fields'

const PERSON_TAG_KEY = 'person'

export interface MissingPersonResolution {
  readonly kind: 'missing'
  readonly emails: readonly string[]
}

export interface ExistingPersonResolution {
  readonly kind: 'existing'
  readonly emails: readonly string[]
  readonly path: string
  readonly title: string
  readonly insertText: string
}

export interface BlockedPersonResolution {
  readonly kind: 'blocked'
  readonly emails: readonly string[]
  readonly reason: 'identity-conflict' | 'unaddressable-owner'
}

/** The graph's answer for a set of email identities. */
export type PersonResolution =
  | MissingPersonResolution
  | ExistingPersonResolution
  | BlockedPersonResolution

interface PersonOwnerRow {
  readonly path: string
  readonly title: string
}

async function personOwners(emails: readonly string[]): Promise<PersonOwnerRow[]> {
  const owners = new Map<string, PersonOwnerRow>()
  for (const chunk of inClauseChunks(emails)) {
    const rows = await db
      .selectFrom('noteEmails')
      .innerJoin('notes', 'notes.path', 'noteEmails.notePath')
      .innerJoin('tags', 'tags.notePath', 'notes.path')
      .where('noteEmails.emailKey', 'in', chunk)
      .where('tags.tagKey', '=', PERSON_TAG_KEY)
      .where('notes.kind', '=', 'note')
      .select(['notes.path as path', 'notes.title as title'])
      .distinct()
      .orderBy('notes.path')
      .execute()
    for (const row of rows) {
      owners.set(row.path, row)
    }
  }
  return [...owners.values()].sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * Resolve all supplied emails as one person identity. Primary-email order has
 * no ownership priority: zero unique owner paths is missing, one is reusable,
 * and more than one is a conflict.
 */
export async function resolvePerson(
  values: readonly string[],
): Promise<PersonResolution> {
  const emails = canonicalEmails(values)
  if (emails.length === 0) {
    return { kind: 'missing', emails }
  }
  const owners = await personOwners(emails)
  if (owners.length === 0) {
    return { kind: 'missing', emails }
  }
  if (owners.length > 1) {
    return { kind: 'blocked', emails, reason: 'identity-conflict' }
  }
  const owner = owners[0]
  if (owner === undefined) {
    return { kind: 'missing', emails }
  }
  const address = await getWikiAddressForPath(owner.path)
  if (address === null) {
    return { kind: 'blocked', emails, reason: 'unaddressable-owner' }
  }
  return {
    kind: 'existing',
    emails,
    path: owner.path,
    title: address.title,
    insertText: address.insertText,
  }
}

export interface EnsurePersonNoteInput {
  readonly title: string
  readonly emails: readonly string[]
  readonly generation: number
  readonly body?: string
}

export type EnsurePersonNoteResult =
  | ExistingPersonResolution
  | BlockedPersonResolution
  | ResolveOrCreateNoteResult

/**
 * Recheck email ownership immediately before creating a person note. Existing
 * and blocked identities never create; only a current ownership miss reaches
 * the ordinary title resolver and atomic path claim.
 */
export async function ensurePersonNote(
  input: EnsurePersonNoteInput,
): Promise<EnsurePersonNoteResult> {
  const resolution = await resolvePerson(input.emails)
  if (resolution.kind !== 'missing') {
    return resolution
  }
  return resolveOrCreateNoteWithTitle(
    input.title,
    input.generation,
    input.body,
  )
}
