import { useQuery } from '@tanstack/react-query'
import {
  contactDetailsMarkdown,
  contactNamesEqual,
  hasBridge,
  isContactsReadable,
  isDaily,
  noteHasContactDetails,
  parseNote,
  splitFrontmatter,
  suggestContactForTitle,
  type ContactMatch,
} from '@reflect/core'
import { readNoteSource } from '@/lib/note-frontmatter'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'
import { useContactsAuthorization } from './use-contacts-authorization'

export function suggestedContactQueryKey(
  graphRoot: string | undefined,
  path: string,
): readonly [typeof INDEX_QUERY_SCOPE, string | undefined, 'suggested-contact', string] {
  return [INDEX_QUERY_SCOPE, graphRoot, 'suggested-contact', path]
}

/**
 * The Apple Contact this note's title exactly matches, or `null` — the
 * suggested-contact card renders on a non-null answer. Gated hard: the
 * integration must be enabled, the permission readable, and the note a
 * non-daily one. Suppression follows v1's model:
 *
 * - **content** — a body that already carries contact details (an email, an
 *   `Email:`/`Phone:` bullet) gets no card, whether Add wrote them or the
 *   user typed them. This is also what hides the card after Add.
 * - **dismissals** — a contact named in the note's `ignoredContacts`
 *   frontmatter list never re-suggests; other contacts still may.
 *
 * Keyed under the `index` scope on purpose: resolving the card writes the
 * note, the watcher re-indexes it, and the usual index invalidation refetches
 * this — the card hides through the same file-is-truth loop as everything else.
 */
export function useSuggestedContact(path: string): ContactMatch | null {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const authorization = useContactsAuthorization()
  const readable = authorization !== null && isContactsReadable(authorization)
  const enabled =
    hasBridge() && graph !== null && settings.contactsEnabled && readable && !isDaily(path)
  const { data } = useQuery({
    queryKey: suggestedContactQueryKey(graph?.root, path),
    queryFn: async () => {
      const source = await readNoteSource(path)
      if (noteHasContactDetails(splitFrontmatter(source).body)) {
        return null
      }
      const note = parseNote({ path, source })
      const match = await suggestContactForTitle(note.title)
      // A match with nothing to add (no email, no phone) has no card to offer.
      if (match === null || contactDetailsMarkdown(match) === '') {
        return null
      }
      const dismissed = note.frontmatter.ignoredContacts.some((name) =>
        contactNamesEqual(name, match.fullName),
      )
      return dismissed ? null : match
    },
    enabled,
  })
  // A disabled query still serves its last cached answer — but once the gate
  // is off (integration disabled, permission revoked), the card must drop
  // immediately, not on the next cache sweep.
  return enabled ? (data ?? null) : null
}
