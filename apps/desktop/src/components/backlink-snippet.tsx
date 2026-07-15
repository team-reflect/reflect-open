import { useCallback, type ReactElement } from 'react'
import { MarkdownView } from '@meowdown/react'
import type {
  FileClickHandler,
  FileInfoResolver,
  FileLinkResolver,
  LinkClickHandler,
  WikiEmbedResolver,
  WikilinkClickHandler,
} from '@meowdown/core'
import { errorMessage, type SnippetTask } from '@reflect/core'
import { useOpenExternalLink } from '@/editor/open-external-link'
import type { AssetPersistence } from '@/editor/use-asset-persistence'
import type { BacklinkNavigation } from '@/hooks/use-backlink-navigation'
import { useSnippetTaskToggle } from '@/hooks/use-snippet-task-toggle'

interface BacklinkSnippetProps {
  /** The referencing block context's Markdown source (may span several lines). */
  text: string
  /** Graph-relative path of the source note the snippet was read from. */
  notePath: string
  /** The snippet's checkbox tasks anchored to the source note (query-provided). */
  tasks: SnippetTask[]
  /** Navigate a clicked `[[wiki link]]` to its target. Pass a stable function. */
  onWikilinkClick: BacklinkNavigation['onWikilinkClick']
  /** Navigate a standard Markdown note link from this source note. */
  onMarkdownLinkClick: BacklinkNavigation['onMarkdownLinkClick']
  /** Resolve `![…](…)` sources to displayable URLs. Pass a stable function. */
  resolveImageUrl: (sourcePath: string, src: string) => string | undefined
  resolveFileLink: AssetPersistence['resolveFileLinkFromSource']
  resolveWikiEmbed: AssetPersistence['resolveWikiEmbedFromSource']
  resolveFileInfo: AssetPersistence['resolveFileInfoFromSource']
  openAttachment: AssetPersistence['openAttachmentFromSource']
  resolverRevision: number
}

/**
 * One reference in the incoming-backlinks panel, rendered as rich text through
 * meowdown's editor-free `MarkdownView`: wiki links become the editor's
 * clickable chips and inline marks render instead of raw `[[…]]` / `**…**`
 * source. The context is a whole block (old Reflect's rules — a paragraph, the
 * containing list item with its children, or a heading's section), so it
 * renders unclamped: truncating would cut the nested structure the context
 * exists to show. Round `+ [ ]` task checkboxes are live — a click writes the
 * toggle through to the source note ({@link useSnippetTaskToggle}), old
 * Reflect's backlink-context behavior — while square GFM boxes stay read-only
 * (the `reflect-backlink-snippet` CSS keeps them inert-looking). The
 * `reflect-editor` class shares the editor's chip styling; the
 * `reflect-backlink-snippet` wrapper keeps it in the panel's compact line box.
 */
export function BacklinkSnippet({
  text,
  notePath,
  tasks,
  onWikilinkClick,
  onMarkdownLinkClick,
  resolveImageUrl,
  resolveFileLink,
  resolveWikiEmbed,
  resolveFileInfo,
  openAttachment,
  resolverRevision,
}: BacklinkSnippetProps): ReactElement {
  const onTaskClick = useSnippetTaskToggle(notePath, tasks)
  const openExternalLink = useOpenExternalLink()
  const handleWikilinkClick = useCallback<WikilinkClickHandler>(
    (payload) => onWikilinkClick(notePath, payload),
    [notePath, onWikilinkClick],
  )
  const handleLinkClick = useCallback<LinkClickHandler>(
    (payload) => {
      payload.event.preventDefault()
      if (!onMarkdownLinkClick(notePath, payload)) {
        openExternalLink(payload)
      }
    },
    [notePath, onMarkdownLinkClick, openExternalLink],
  )
  const resolveSnippetImageUrl = useCallback(
    (src: string) => {
      void resolverRevision
      return resolveImageUrl(notePath, src)
    },
    [notePath, resolveImageUrl, resolverRevision],
  )
  const resolveSnippetFileLink = useCallback<FileLinkResolver>(
    (payload) => {
      void resolverRevision
      return resolveFileLink(notePath, payload)
    },
    [notePath, resolveFileLink, resolverRevision],
  )
  const resolveSnippetWikiEmbed = useCallback<WikiEmbedResolver>(
    (embed) => {
      void resolverRevision
      return resolveWikiEmbed(notePath, embed)
    },
    [notePath, resolveWikiEmbed, resolverRevision],
  )
  const resolveSnippetFileInfo = useCallback<FileInfoResolver>(
    (href) => {
      void resolverRevision
      return resolveFileInfo(notePath, href)
    },
    [notePath, resolveFileInfo, resolverRevision],
  )
  const handleFileClick = useCallback<FileClickHandler>(
    ({ href }) => {
      void openAttachment(notePath, href).catch((cause) => {
        console.error('open attachment failed:', errorMessage(cause))
      })
    },
    [notePath, openAttachment],
  )
  return (
    <div className="reflect-backlink-snippet select-text text-xs text-text">
      <MarkdownView
        className="reflect-editor"
        markdown={text}
        onWikilinkClick={handleWikilinkClick}
        onLinkClick={handleLinkClick}
        {...(onTaskClick ? { onTaskClick } : {})}
        resolveImageUrl={resolveSnippetImageUrl}
        resolveFileLink={resolveSnippetFileLink}
        resolveWikiEmbed={resolveSnippetWikiEmbed}
        resolveFileInfo={resolveSnippetFileInfo}
        onFileClick={handleFileClick}
      />
    </div>
  )
}
