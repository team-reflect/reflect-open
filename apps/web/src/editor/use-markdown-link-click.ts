import { useCallback } from 'react'
import type { LinkClickHandler } from '@meowdown/core'
import { useLinkNavigationHost } from '@/hooks/use-link-navigation-host.ts'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * The click policy for a rendered Markdown link: an attachment opens through
 * the asset command, a `reflect://` link through the deep-link pipeline, any
 * other allowed scheme through the OS opener, and a scheme-less href is a
 * note link resolved from `sourcePath`. A `null` `sourcePath` means the
 * Markdown belongs to no note, so attachment and note links do nothing.
 */
export function useMarkdownLinkClick(sourcePath: string | null): LinkClickHandler {
  const { linkNavigation } = useAppServices()
  const host = useLinkNavigationHost()

  return useCallback<LinkClickHandler>(
    ({ href, event, mod }) => {
      event.preventDefault()
      linkNavigation.followMarkdownLink({ href, sourcePath, openInNewWindow: mod }, host)
    },
    [host, linkNavigation, sourcePath],
  )
}
