import { errorMessage, parseNote, type NoteRow } from '@reflect/core'
import { commitNoteFrontmatter, readNoteSource } from '@/lib/note-frontmatter'
import { startOperation } from '@/lib/operations'
import { queryKeys } from '@/lib/query-client'
import type { NoteActionInput } from './notes/types'

const pendingPrivacy = new Set<string>()

/** Toggle privacy with shared optimistic feedback and save-error reporting. Markdown owns the final state. */
export async function toggleNotePrivate(input: NoteActionInput): Promise<void> {
  const { queryClient, root, generation, path } = input
  const key = JSON.stringify([root, generation, path])
  if (pendingPrivacy.has(key)) {
    return
  }
  pendingPrivacy.add(key)
  const queryKey = queryKeys.index.note(root, path)
  const apply = (isPrivate: boolean): void => {
    queryClient.setQueryData<NoteRow | null>(queryKey, (row) => (row ? { ...row, isPrivate } : row))
  }
  try {
    await queryClient.cancelQueries({ queryKey, exact: true })
    const previous = queryClient.getQueryData<NoteRow | null>(queryKey)
    const predicted = !(previous?.isPrivate ?? false)
    apply(predicted)

    const source = await readNoteSource(path)
    const actual = !parseNote({ path, source }).frontmatter.private
    await commitNoteFrontmatter(path, { private: actual }, generation)
    if (actual !== predicted) {
      apply(actual)
    }
  } catch (cause) {
    void queryClient.invalidateQueries({ queryKey, exact: true })
    startOperation('Updating privacy').fail(errorMessage(cause))
  } finally {
    pendingPrivacy.delete(key)
  }
}
