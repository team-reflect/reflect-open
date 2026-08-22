import { classifyAssetFromNotes } from '../../actions/asset-privacy'
import { descriptionPathFor, isAssetPath, isNotePath, isTemplatePath } from '../../graph/paths'
import { assetReferencingNotePaths } from '../../indexing/asset-refs'
import { parseNote } from '../../markdown/extract'
import type { ChatSourceRef } from './transcript'

export interface ValidateChatSourceDeps {
  /** Freshest note source, including an open editor buffer when applicable. */
  readNote(path: string): Promise<string>
  /** Live graph paths of notes that reference one canonical asset path. */
  assetReferencingNotePaths?: ((assetPath: string) => Promise<string[]>) | undefined
}

/**
 * Revalidate one earlier tool source immediately before a provider request.
 * Every error fails closed. Asset descriptions must still exist and remain
 * referenced exclusively by public notes.
 */
export async function validateChatSource(
  source: ChatSourceRef,
  deps: ValidateChatSourceDeps,
): Promise<boolean> {
  try {
    if (source.kind === 'note') {
      if (!isNotePath(source.path) || isTemplatePath(source.path)) {
        return false
      }
      return !parseNote({ path: source.path, source: await deps.readNote(source.path) }).frontmatter
        .private
    }
    if (!isAssetPath(source.path)) {
      return false
    }
    await deps.readNote(descriptionPathFor(source.path))
    const referers = await (deps.assetReferencingNotePaths ?? assetReferencingNotePaths)(
      source.path,
    )
    return (await classifyAssetFromNotes(source.path, referers, deps.readNote)) === 'send'
  } catch {
    return false
  }
}
