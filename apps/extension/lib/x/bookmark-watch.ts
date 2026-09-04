import { articlePermalink } from './extract-post'
import { ARTICLE_SELECTOR, testIdSelector, X_TEST_IDS } from './x-markup'

/**
 * Watch X's page for bookmark and like state changes (Plan 25). X renders
 * each post's action buttons with `data-testid="bookmark"` /
 * `"removeBookmark"` (and `"like"` / `"unlike"`), and flips them — on the
 * same element or by re-mounting — whichever way the user acted: the button,
 * the `b`/`l` keys, the share menu, the detail page. So the watcher never
 * looks at what the user did, only at what each post's state *became*: the
 * first sight of a post records its baseline (already-bookmarked posts on
 * the timeline or the bookmarks page never fire), and only a change from
 * that baseline is reported.
 */

export type PostAction = 'bookmark' | 'like'

export interface PostStateChange {
  article: Element
  id: string
  action: PostAction
  /** `true` when the post just became bookmarked/liked; `false` when released. */
  active: boolean
}

interface PostState {
  bookmarked: boolean | null
  liked: boolean | null
}

/** Bound the per-page memory; X timelines are effectively infinite. */
const STATE_CAP = 2000

function controlState(article: Element, on: string, off: string): boolean | null {
  const control = article.querySelector(`button${testIdSelector(on)}, button${testIdSelector(off)}`)
  if (control === null) {
    return null
  }
  return control.getAttribute('data-testid') === on
}

/** The article's current state; `null` where the control is not rendered. */
export function articleState(article: Element): PostState {
  return {
    bookmarked: controlState(article, X_TEST_IDS.removeBookmark, X_TEST_IDS.bookmark),
    liked: controlState(article, X_TEST_IDS.unlike, X_TEST_IDS.like),
  }
}

function articlesTouchedBy(records: readonly MutationRecord[], root: Node): Set<Element> {
  const articles = new Set<Element>()
  const add = (candidate: Element | null): void => {
    if (candidate !== null && root.contains(candidate)) {
      articles.add(candidate)
    }
  }
  for (const record of records) {
    const target =
      record.target.nodeType === record.target.ELEMENT_NODE
        ? (record.target as Element)
        : record.target.parentElement
    add(target?.closest(ARTICLE_SELECTOR) ?? null)
    for (const node of record.addedNodes) {
      if (node.nodeType !== node.ELEMENT_NODE) {
        continue
      }
      const element = node as Element
      if (element.matches(ARTICLE_SELECTOR)) {
        add(element)
      } else {
        add(element.closest(ARTICLE_SELECTOR))
        for (const nested of element.querySelectorAll(ARTICLE_SELECTOR)) {
          add(nested)
        }
      }
    }
  }
  return articles
}

/**
 * Start watching `root`. Returns a stop function. `onChange` fires once per
 * transition, after the state map already reflects it, so a burst of
 * mutations for one action reports once.
 */
export function startBookmarkWatch(
  root: Node & ParentNode,
  onChange: (change: PostStateChange) => void,
): () => void {
  const states = new Map<string, PostState>()

  const remember = (id: string, state: PostState): void => {
    states.delete(id)
    states.set(id, state)
    if (states.size > STATE_CAP) {
      const oldest = states.keys().next().value
      if (oldest !== undefined) {
        states.delete(oldest)
      }
    }
  }

  const evaluate = (article: Element): void => {
    const id = articlePermalink(article)?.id
    if (id === undefined) {
      return
    }
    const current = articleState(article)
    const previous = states.get(id)
    if (previous === undefined) {
      remember(id, current)
      return
    }
    const next: PostState = {
      bookmarked: current.bookmarked ?? previous.bookmarked,
      liked: current.liked ?? previous.liked,
    }
    remember(id, next)
    if (
      previous.bookmarked !== null &&
      current.bookmarked !== null &&
      previous.bookmarked !== current.bookmarked
    ) {
      onChange({ article, id, action: 'bookmark', active: current.bookmarked })
    }
    if (previous.liked !== null && current.liked !== null && previous.liked !== current.liked) {
      onChange({ article, id, action: 'like', active: current.liked })
    }
  }

  for (const article of root.querySelectorAll(ARTICLE_SELECTOR)) {
    evaluate(article)
  }
  const observer = new MutationObserver((records) => {
    for (const article of articlesTouchedBy(records, root)) {
      evaluate(article)
    }
  })
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-testid'],
  })
  return () => {
    observer.disconnect()
    states.clear()
  }
}
