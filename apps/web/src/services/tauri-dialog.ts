import { open } from '@tauri-apps/plugin-dialog'
import type { DialogService, PickFilesOptions } from '@reflect/app'

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
    return Array.isArray(picked) ? picked : [picked]
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
