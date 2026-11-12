import type { DialogService } from '@reflect/app'

class BrowserDialogServiceImpl implements DialogService {
  pickFiles(): readonly string[] | null {
    return null
  }

  pickFolder(): string | null {
    return null
  }
}

/**
 * Plain-browser dev has no native open panel, so every picker reads as a cancel.
 */
export function createBrowserDialogService(): DialogService {
  return new BrowserDialogServiceImpl()
}
