import type { XPost } from '@reflect/core/capture-envelope'
import { xPostId } from '@reflect/core/x-post'

const ARTICLE = 'article, [data-testid="quoteTweet"]'
const TEXT = '[data-testid="tweetText"], div.whitespace-pre-wrap'

function ownElements(root: Element, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector)).filter(
    (element) => element.closest(ARTICLE) === root,
  )
}

function permalink(root: Element): string | null {
  const links = ownElements(root, 'a[href*="/status/"]')
  const timed = links.find((link) => link.querySelector('time'))
  return (timed ?? links[0])?.getAttribute('href') ?? null
}

function postText(root: Element, limit: number): XPost['text'] {
  const element = ownElements(root, TEXT)[0]
  if (!(element instanceof HTMLElement)) return undefined
  const text = element.innerText.trim()
  if (!text) return undefined
  return {
    value: text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, ''),
    complete:
      text.length <= limit &&
      !element.className.includes('line-clamp') &&
      ownElements(root, '[data-testid="tweet-text-show-more-link"]').length === 0,
  }
}

/** Read the article's own post, excluding nested articles and quote controls. */
export function readXArticle(article: Element, includeQuote = true): XPost | undefined {
  const link = permalink(article)
  const id = link ? xPostId(new URL(link, location.href).href) : null
  if (!id) return undefined
  const author = ownElements(article, '[data-testid="User-Name"]')[0]
  const authorLinks = ownElements(article, 'a[href]').filter(
    (element) => !element.getAttribute('href')?.includes('/status/'),
  )
  const handle = (
    author?.textContent ?? authorLinks.map((element) => element.textContent).join(' ')
  ).match(/@([A-Za-z0-9_]{1,32})/)?.[1]
  const name = (
    author?.querySelector('a span')?.textContent ??
    authorLinks.find((element) => element.textContent?.trim() && !element.textContent.includes('@'))
      ?.textContent
  )
    ?.trim()
    .slice(0, 200)
  const images = ownElements(
    article,
    '[data-testid="tweetPhoto"] img, a[href*="/photo/"] img, video[poster]',
  )
    .flatMap((element) => {
      const url = element instanceof HTMLImageElement ? element.src : element.getAttribute('poster')
      if (!url || url.length > 2048) return []
      try {
        if (new URL(url).protocol !== 'https:') return []
      } catch {
        return []
      }
      const alt = element.getAttribute('alt')?.slice(0, 2000)
      return [{ url, ...(alt ? { alt } : {}) }]
    })
    .filter((image, index, all) => all.findIndex((other) => other.url === image.url) === index)
    .slice(0, 4)
  const text = postText(article, 20000)
  const quoteArticle = Array.from(article.querySelectorAll(ARTICLE)).find(
    (nested) => nested.parentElement?.closest(ARTICLE) === article,
  )
  const quotePost = includeQuote && quoteArticle ? readXArticle(quoteArticle, false) : undefined
  return {
    id,
    ...(handle && name ? { author: { name, handle } } : {}),
    ...(text ? { text } : {}),
    ...(images.length ? { images } : {}),
    ...(quotePost
      ? {
          quote: {
            id: quotePost.id,
            ...(quotePost.author ? { author: quotePost.author } : {}),
            ...(quotePost.text
              ? {
                  text: {
                    value: quotePost.text.value.slice(0, 5000).replace(/[\uD800-\uDBFF]$/, ''),
                    complete: quotePost.text.complete && quotePost.text.value.length <= 5000,
                  },
                }
              : {}),
          },
        }
      : {}),
  }
}

/** Find the requested detail post rather than a reply or a quoted status. */
export function readXPage(expectedUrl: string): XPost | undefined {
  const id = xPostId(expectedUrl)
  if (!id || xPostId(location.href) !== id) return undefined
  for (const article of document.querySelectorAll(ARTICLE)) {
    const post = readXArticle(article)
    if (post?.id === id) return post
  }
  return undefined
}

type Trigger = 'bookmark' | 'like'

/** Observe state confirmation following a trusted user action, never initial selected icons. */
export function watchXActions(onCapture: (post: XPost, trigger: Trigger) => void): () => void {
  const pending = new Map<string, { article: Element; trigger: Trigger; expires: number }>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const observer = new MutationObserver(confirm)

  function confirm(): void {
    for (const [key, action] of pending) {
      if (Date.now() > action.expires) {
        pending.delete(key)
        continue
      }
      const selected = action.trigger === 'bookmark' ? 'removeBookmark' : 'unlike'
      if (
        ownElements(
          action.article,
          `[data-testid="${selected}"], button[aria-label="${action.trigger === 'bookmark' ? 'Bookmark' : 'Like'}"][aria-pressed="true"]`,
        ).length
      ) {
        pending.delete(key)
        const post = readXArticle(action.article)
        if (post) onCapture(post, action.trigger)
      }
    }
    if (pending.size === 0) observer.disconnect()
  }

  function onAction(event: Event): void {
    if (!event.isTrusted || !(event.target instanceof Element)) return
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return
    const control = event.target.closest(
      '[data-testid="bookmark"], [data-testid="like"], button[aria-label="Bookmark"][aria-pressed="false"], button[aria-label="Like"][aria-pressed="false"]',
    )
    const article = control?.closest(ARTICLE)
    if (!control || !article || control.closest('[data-testid="quoteTweet"]')) return
    const post = readXArticle(article)
    if (!post) return
    const trigger =
      control.getAttribute('data-testid') === 'bookmark' ||
      control.getAttribute('aria-label') === 'Bookmark'
        ? 'bookmark'
        : 'like'
    pending.set(`${post.id}:${trigger}`, { article, trigger, expires: Date.now() + 3000 })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-testid', 'aria-pressed'],
    })
    if (timer) clearTimeout(timer)
    timer = setTimeout(confirm, 3100)
  }

  document.addEventListener('click', onAction, true)
  document.addEventListener('keydown', onAction, true)
  return () => {
    document.removeEventListener('click', onAction, true)
    document.removeEventListener('keydown', onAction, true)
    observer.disconnect()
    if (timer) clearTimeout(timer)
    pending.clear()
  }
}
