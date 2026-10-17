import type { MaybePromise } from '@reflect/utils'
/**
 * A file type filter for {@link DialogService.pickFiles}.
 */
export interface DialogFilter {
  name: string
  extensions: readonly string[]
}

export interface PickFilesOptions {
  multiple: boolean
  title: string
  filters?: readonly DialogFilter[]
}

export interface PickFolderOptions {
  title: string
  /**
   * The folder the picker starts in.
   */
  defaultPath?: string
}

/**
 * Native open panels. Every method resolves `null` when the user cancels.
 */
export interface DialogService {
  /**
   * Absolute paths of the picked files.
   */
  pickFiles(options: PickFilesOptions): MaybePromise<readonly string[] | null>
  /**
   * The absolute path of the picked folder.
   */
  pickFolder(options: PickFolderOptions): MaybePromise<string | null>
}
