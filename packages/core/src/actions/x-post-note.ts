import { wikiLinkSafe } from '../markdown/edit'
import type { XPost } from './capture-envelope'
import type { XCaptureInput } from './x-capture'
import { xPostUrl } from './x-post'

function plainText(value: string): string {
  return value.replaceAll(/[\\`*_{}\[\]()#+\-.!|<>]/g, '\\$&')
}

/** A stable, readable heading even when only the post URL was captured. */
export function xPostTitle(post: XPost): string {
  const author = post.author?.name.trim() || post.author?.handle
  return wikiLinkSafe(author ? `${author} on X` : `X post ${post.id}`)
}

/** Render a snapshot once; remote media remains a link until saved locally. */
export function renderXPostNote(
  input: XCaptureInput,
  localImages: ReadonlyMap<string, string> = new Map(),
): string {
  const { post } = input
  const parts = [`# ${plainText(xPostTitle(post))}`, `[View on X](${xPostUrl(post.id)})`]
  if (post.author) parts.push(plainText(`@${post.author.handle}`))
  if (post.text) parts.push(plainText(post.text.value))
  if (post.quote) {
    const quote = post.quote
    const content = [
      `[Quoted post](${xPostUrl(quote.id)})`,
      ...(quote.author ? [plainText(`@${quote.author.handle}`)] : []),
      ...(quote.text ? [plainText(quote.text.value)] : []),
    ].join('\n\n')
    parts.push(
      content
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
    )
  }
  for (const image of post.images ?? []) {
    const local = localImages.get(image.url)
    parts.push(
      local
        ? `![${plainText(image.alt ?? 'Post image')}](${local})`
        : `[Image source](<${encodeURI(image.url).replaceAll('>', '%3E')}>)`,
    )
  }
  if (input.note) parts.push(`## Note\n\n${input.note}`)
  if (input.selection) parts.push(`## Selection\n\n${plainText(input.selection)}`)
  if (input.screenshot) parts.push(`## Screenshot\n\n![Screenshot](${input.screenshot})`)
  return `${parts.join('\n\n')}\n`
}
