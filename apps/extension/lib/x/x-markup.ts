/**
 * The X page markup the extension depends on (Plan 25) — every `data-testid`
 * the extractor and the bookmark watcher read, in one place. X owns these
 * names; when they change, this is the file to update, and the phase-3
 * selector smoke test is meant to import from here.
 */

export const X_TEST_IDS = {
  article: 'tweet',
  text: 'tweetText',
  showMore: 'tweet-text-show-more-link',
  userName: 'User-Name',
  bookmark: 'bookmark',
  removeBookmark: 'removeBookmark',
  like: 'like',
  unlike: 'unlike',
} as const

/** `[data-testid="…"]` for one of {@link X_TEST_IDS}. */
export function testIdSelector(testId: string): string {
  return `[data-testid="${CSS.escape(testId)}"]`
}

/** One post on the page, on the timeline or the detail view. */
export const ARTICLE_SELECTOR = `article${testIdSelector(X_TEST_IDS.article)}`
