import { open } from '@tauri-apps/plugin-dialog'
import type { DialogService, PickFilesOptions } from '@reflect/app'

/**
 * The filesystem path of one picked entry. Desktop panels answer paths; the
 * iOS document picker copies each pick into the app sandbox and answers its
 * `file://` URL, which the Rust commands that import it cannot open.
 */
export function pickedPath(picked: string): string {
  return picked.startsWith('file://') ? decodeURIComponent(new URL(picked).pathname) : picked
}

class TauriDialogServiceImpl implements DialogService {
  async pickFiles({
    multiple,
    title,
    filters,
  }: PickFilesOptions): Promise<readonly string[] | null> {
    const picked = await open({
      multiple,
      directory: false,
      title,
      ...(filters === undefined
        ? {}
        : {
            filters: filters.map((filter) => ({
              name: filter.name,
              extensions: [...filter.extensions],
            })),
          }),
    })
    if (picked === null) {
      return null
    }
    return (Array.isArray(picked) ? picked : [picked]).map(pickedPath)
  }

  async pickFolder({
    title,
    defaultPath,
  }: Parameters<DialogService['pickFolder']>[0]): Promise<string | null> {
    const picked = await open({
      directory: true,
      multiple: false,
      title,
      ...(defaultPath === undefined ? {} : { defaultPath }),
    })
    return typeof picked === 'string' ? picked : null
  }
}

/**
 * Native open panels through `@tauri-apps/plugin-dialog`.
 */
export function createTauriDialogService(): DialogService {
  return new TauriDialogServiceImpl()
}
