import { convertFileSrc } from '@tauri-apps/api/core'

type BrowserAttachmentUrlResolver = (generation: number, path: string) => string | null

interface InstalledBrowserResolver {
  readonly resolve: BrowserAttachmentUrlResolver
  readonly dispose: () => void
}

let browserAttachmentUrlResolver: InstalledBrowserResolver | null = null

/**
 * Install the plain-browser attachment URL resolver used by the development
 * bridge. Native shells never install one and continue using Tauri's custom
 * protocol. Returns a scoped cleanup so replacing a dev graph cannot leave a
 * resolver pointing at the previous graph's in-memory files.
 */
export function installBrowserAttachmentUrlResolver(
  resolver: BrowserAttachmentUrlResolver,
  dispose: () => void = () => {},
): () => void {
  browserAttachmentUrlResolver?.dispose()
  const installed = { resolve: resolver, dispose }
  browserAttachmentUrlResolver = installed
  return () => {
    if (browserAttachmentUrlResolver === installed) {
      browserAttachmentUrlResolver = null
      installed.dispose()
    }
  }
}

/** Build a generation-pinned display URL for a resolved local attachment. */
export function attachmentDisplayUrl(
  generation: number,
  path: string,
  catalogRevision: number,
): string | null {
  if (browserAttachmentUrlResolver !== null) {
    return browserAttachmentUrlResolver.resolve(generation, path)
  }
  const url = convertFileSrc(`${generation}/${path}`, 'reflect-asset')
  return `${url}?reflect-catalog=${catalogRevision}`
}
