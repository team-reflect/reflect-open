import type { ConfirmOptions, DialogService } from '@reflect/app'

class BrowserDialogServiceImpl implements DialogService {
  pickFiles(): readonly string[] | null {
    return null
  }

  pickFolder(): string | null {
    return null
  }

  confirm({ title, message }: ConfirmOptions): Promise<boolean> {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`))
  }
}

/**
 * Plain-browser dev has no native open panel, so every picker reads as a
 * cancel. Alerts use `window.confirm`.
 */
export function createBrowserDialogService(): DialogService {
  return new BrowserDialogServiceImpl()
}
