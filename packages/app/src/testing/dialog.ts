import type { DialogService, PickFilesOptions, PickFolderOptions } from '../app/dialog-service.ts'

export type DialogCall =
  | { readonly kind: 'files'; readonly options: PickFilesOptions }
  | { readonly kind: 'folder'; readonly options: PickFolderOptions }

export interface TestDialogService extends DialogService {
  /**
   * What the next file pickers return; `null` reads as a cancel.
   */
  setFiles(files: readonly string[] | null): void
  /**
   * What the next folder pickers return; `null` reads as a cancel.
   */
  setFolder(folder: string | null): void
  calls(): readonly DialogCall[]
}

class TestDialogServiceImpl implements TestDialogService {
  #files: readonly string[] | null
  #folder: string | null
  readonly #log: DialogCall[] = []

  constructor(files: readonly string[] | null, folder: string | null) {
    this.#files = files
    this.#folder = folder
  }

  pickFiles(options: PickFilesOptions): readonly string[] | null {
    this.#log.push({ kind: 'files', options })
    return this.#files
  }

  pickFolder(options: PickFolderOptions): string | null {
    this.#log.push({ kind: 'folder', options })
    return this.#folder
  }

  setFiles(files: readonly string[] | null): void {
    this.#files = files
  }

  setFolder(folder: string | null): void {
    this.#folder = folder
  }

  calls(): readonly DialogCall[] {
    return [...this.#log]
  }
}

/**
 * A {@link DialogService} that answers every picker with preset paths.
 * Defaults to cancel.
 */
export function createTestDialogService(options?: {
  files?: readonly string[] | null
  folder?: string | null
}): TestDialogService {
  return new TestDialogServiceImpl(options?.files ?? null, options?.folder ?? null)
}
