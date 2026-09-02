import {
  POST_TEXT_MAX_LENGTH,
  type CapturedPost,
  type PostAuthor,
  type PostTrigger,
} from '@reflect/core/capture-envelope'
import { parsePostUrl, type PostPermalink } from '@reflect/core/post-url'
import { ARTICLE_SELECTOR, testIdSelector, X_TEST_IDS } from './x-markup'

/**
 * Read a post off X's page (Plan 25) — the minimal contract: the id from
 * the article's permalink, the author, the text as rendered, and whether
 * the page truncated it. Everything is best-effort against X's `data-testid`
 * markup; a post the page cannot be read from still captures by id, and the
 * desktop's enrichment fetches the rest. Media and quoted posts are left to
 * enrichment for now.
 */

/** The nested quoted post, when any — never read its text as the article's. */
function isInsideQuotedPost(element: Element, article: Element): boolean {
  const link = element.closest('[role="link"]')
  return link !== null && link !== article && article.contains(link)
}

function firstOwnMatch(article: Element, selector: string): Element | null {
  for (const candidate of article.querySelectorAll(selector)) {
    if (!isInsideQuotedPost(candidate, article)) {
      return candidate
    }
  }
  return null
}

/** The article's permalink (the anchor around its timestamp). */
export function articlePermalink(article: Element): PostPermalink | null {
  const candidates = [
    ...Array.from(article.querySelectorAll('time'), (time) => time.closest('a')),
    ...Array.from(article.querySelectorAll('a[href*="/status/"]')),
  ]
  for (const anchor of candidates) {
    if (anchor === null || isInsideQuotedPost(anchor, article)) {
      continue
    }
    const href = anchor.getAttribute('href')
    if (href === null) {
      continue
    }
    const permalink = parsePostUrl(new URL(href, 'https://x.com').href)
    if (permalink !== null) {
      return permalink
    }
  }
  return null
}

/**
 * The text as a reader sees it: text nodes, emoji `<img alt>`, link display
 * text, and `<br>` as line breaks.
 */
export function renderedText(root: Node): string {
  const parts: string[] = []
  const visit = (node: Node): void => {
    if (node.nodeType === node.TEXT_NODE) {
      // HTML whitespace collapses in rendering; only `<br>` breaks lines.
      parts.push((node.textContent ?? '').replaceAll(/\s+/g, ' '))
      return
    }
    if (node.nodeType !== node.ELEMENT_NODE) {
      return
    }
    const element = node as Element
    const tag = element.tagName.toUpperCase()
    if (tag === 'IMG') {
      parts.push(element.getAttribute('alt') ?? '')
      return
    }
    if (tag === 'BR') {
      parts.push('\n')
      return
    }
    for (const child of element.childNodes) {
      visit(child)
    }
  }
  visit(root)
  return parts
    .join('')
    .replaceAll(/ *\n */g, '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}

function authorOf(article: Element, handle: string): PostAuthor {
  const userName = firstOwnMatch(article, testIdSelector(X_TEST_IDS.userName))
  if (userName === null) {
    return { name: handle, handle }
  }
  const profileHref = `/${handle}`
  const nameAnchor = Array.from(userName.querySelectorAll('a')).find(
    (anchor) => anchor.getAttribute('href')?.toLowerCase() === profileHref.toLowerCase(),
  )
  const name =
    renderedText(nameAnchor ?? userName)
      .split('\n')[0]
      ?.replace(/^@/, '')
      .trim() ?? ''
  return { name: name === '' || name.startsWith('@') ? handle : name.slice(0, 200), handle }
}

/**
 * Extract the post an article shows, or `null` when the article has no
 * readable permalink (X markup drift — the caller falls back to nothing).
 */
export function extractPost(article: Element, trigger: PostTrigger): CapturedPost | null {
  const permalink = articlePermalink(article)
  if (permalink === null) {
    return null
  }
  const post: CapturedPost = { provider: 'x', id: permalink.id, trigger }
  if (permalink.handle !== null) {
    post.author = authorOf(article, permalink.handle)
  }
  const textElement = firstOwnMatch(article, testIdSelector(X_TEST_IDS.text))
  if (textElement !== null) {
    const text = renderedText(textElement).slice(0, POST_TEXT_MAX_LENGTH)
    if (text !== '') {
      post.text = text
    }
  }
  if (firstOwnMatch(article, testIdSelector(X_TEST_IDS.showMore)) !== null) {
    post.truncated = true
  }
  const time = firstOwnMatch(article, 'time[datetime]')
  const datetime = time?.getAttribute('datetime')
  if (datetime) {
    const parsed = new Date(datetime)
    if (!Number.isNaN(parsed.getTime())) {
      post.postedAt = parsed.toISOString()
    }
  }
  return post
}

/** On a permalink page, the article showing post `id`, or `null`. */
export function findArticleForPost(root: ParentNode, id: string): Element | null {
  for (const article of root.querySelectorAll(ARTICLE_SELECTOR)) {
    if (articlePermalink(article)?.id === id) {
      return article
    }
  }
  return null
}
