// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { articleState, startBookmarkWatch, type PostStateChange } from './bookmark-watch'

function articleHtml(id: string, options: { bookmarked?: boolean; liked?: boolean } = {}): string {
  const bookmark = options.bookmarked ? 'removeBookmark' : 'bookmark'
  const like = options.liked ? 'unlike' : 'like'
  return `<article data-testid="tweet" role="article" id="post-${id}">
    <a href="/jack/status/${id}"><time datetime="2006-03-21T20:50:14.000Z">x</time></a>
    <div data-testid="tweetText">post ${id}</div>
    <button data-testid="${like}"></button>
    <button data-testid="${bookmark}"></button>
  </article>`
}

/** MutationObserver callbacks run on a microtask; let them. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function button(id: string, testid: string): Element {
  return document.querySelector(`#post-${id} button[data-testid="${CSS.escape(testid)}"]`)!
}

let changes: PostStateChange[]
let stop: () => void

beforeEach(() => {
  document.body.innerHTML = `<main>${articleHtml('1')}${articleHtml('2', { bookmarked: true })}</main>`
  changes = []
  stop = startBookmarkWatch(document.body, (change) => {
    changes.push(change)
  })
})

afterEach(() => {
  stop()
})

describe('startBookmarkWatch', () => {
  it('reads each post state', () => {
    expect(articleState(document.querySelector('#post-1')!)).toEqual({
      bookmarked: false,
      liked: false,
    })
    expect(articleState(document.querySelector('#post-2')!)).toEqual({
      bookmarked: true,
      liked: false,
    })
  })

  it('reports a bookmark flip on the same element, once, then the release', async () => {
    button('1', 'bookmark').setAttribute('data-testid', 'removeBookmark')
    await settle()
    // A second mutation burst for the same state must not re-report.
    document.querySelector('#post-1 [data-testid="tweetText"]')!.append(' edited')
    await settle()

    expect(changes.map((change) => [change.id, change.action, change.active])).toEqual([
      ['1', 'bookmark', true],
    ])

    button('1', 'removeBookmark').setAttribute('data-testid', 'bookmark')
    await settle()
    expect(changes.at(-1)).toMatchObject({ id: '1', action: 'bookmark', active: false })
  })

  it('never reports posts that were already bookmarked on first sight', async () => {
    const main = document.querySelector('main')!
    main.insertAdjacentHTML('beforeend', articleHtml('3', { bookmarked: true, liked: true }))
    await settle()
    expect(changes).toEqual([])
  })

  it('reports a re-mounted article whose state changed', async () => {
    const first = document.querySelector('#post-1')!
    first.remove()
    document
      .querySelector('main')!
      .insertAdjacentHTML('beforeend', articleHtml('1', { bookmarked: true }))
    await settle()
    expect(changes.map((change) => [change.id, change.active])).toEqual([['1', true]])
  })

  it('reports likes separately', async () => {
    button('2', 'like').setAttribute('data-testid', 'unlike')
    await settle()
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ id: '2', action: 'like', active: true })
  })

  it('stops reporting once stopped', async () => {
    stop()
    button('1', 'bookmark').setAttribute('data-testid', 'removeBookmark')
    await settle()
    expect(changes).toEqual([])
    stop = vi.fn()
  })
})
