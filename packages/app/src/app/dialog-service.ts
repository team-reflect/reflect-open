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

export interface ConfirmOptions {
  title: string
  message: string
  /**
   * The label of the default button.
   */
  confirm: string
  /**
   * The label of the cancel button.
   */
  cancel: string
}

/**
 * Native open panels and alerts. Every picker resolves `null` when the user
 * cancels.
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
  /**
   * Ask a question with two buttons. Resolves whether the user chose
   * `confirm`.
   */
  confirm(options: ConfirmOptions): Promise<boolean>
}
