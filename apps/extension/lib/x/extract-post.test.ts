// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { articlePermalink, extractPost, findArticleForPost, renderedText } from './extract-post'

/** X's article markup, reduced to the attributes the extractor reads. */
function article(html: string): Element {
  const container = document.createElement('div')
  container.innerHTML = `<article data-testid="tweet" role="article">${html}</article>`
  return container.firstElementChild!
}

const HEADER = `
  <div data-testid="socialContext">Someone reposted</div>
  <div data-testid="User-Name">
    <a href="/jack"><span>jack</span><svg aria-label="Verified"></svg></a>
    <a href="/jack"><span>@jack</span></a>
    <a href="/jack/status/20"><time datetime="2006-03-21T20:50:14.000Z">Mar 21, 2006</time></a>
  </div>`

const QUOTED = `
  <div role="link" tabindex="0">
    <div data-testid="User-Name"><a href="/lexfridman"><span>Lex Fridman</span></a></div>
    <a href="/lexfridman/status/1770825760162353449"><time datetime="2024-03-21T18:00:00.000Z">x</time></a>
    <div data-testid="tweetText"><span>Hello from the future</span></div>
    <div data-testid="tweet-text-show-more-link">Show more</div>
  </div>`

const ACTIONS = `<button data-testid="bookmark"></button><button data-testid="like"></button>`

describe('extractPost', () => {
  it('reads id, author, rendered text, truncation, and timestamp', () => {
    const post = extractPost(
      article(`${HEADER}
        <div data-testid="tweetText">
          <span>just setting up my </span><img alt="😀" src="emoji.svg"><span>twttr</span><br>
          <a href="https://t.co/x"><span>example.com/fish</span></a>
        </div>
        <div data-testid="tweet-text-show-more-link">Show more</div>
        ${ACTIONS}`),
      'bookmark',
    )
    expect(post).toEqual({
      provider: 'x',
      id: '20',
      trigger: 'bookmark',
      author: { name: 'jack', handle: 'jack' },
      text: 'just setting up my 😀twttr\nexample.com/fish',
      truncated: true,
      postedAt: '2006-03-21T20:50:14.000Z',
    })
  })

  it('never reads the quoted post as the article', () => {
    const post = extractPost(article(`${HEADER}${QUOTED}${ACTIONS}`), 'like')
    expect(post).toEqual({
      provider: 'x',
      id: '20',
      trigger: 'like',
      author: { name: 'jack', handle: 'jack' },
      postedAt: '2006-03-21T20:50:14.000Z',
    })
  })

  it('falls back to the handle as the name and captures by id alone when needed', () => {
    const bare = extractPost(
      article(`<a href="/i/web/status/20"><time datetime="bogus">x</time></a>`),
      'manual',
    )
    expect(bare).toEqual({ provider: 'x', id: '20', trigger: 'manual' })

    const handleOnly = extractPost(
      article(`<a href="/jack/status/20"><time datetime="2006-03-21T20:50:14.000Z">x</time></a>`),
      'manual',
    )
    expect(handleOnly?.author).toEqual({ name: 'jack', handle: 'jack' })
  })

  it('returns null without a permalink', () => {
    expect(extractPost(article(`<div data-testid="tweetText">orphan</div>`), 'manual')).toBeNull()
    expect(articlePermalink(article('<a href="/jack">profile</a>'))).toBeNull()
  })
})

describe('renderedText', () => {
  it('collapses trailing spaces before breaks and runs of blank lines', () => {
    const element = document.createElement('div')
    element.innerHTML = 'one  <br><br><br><br>two \r<br>three'
    expect(renderedText(element)).toBe('one\n\ntwo\nthree')
  })
})

describe('findArticleForPost', () => {
  it('picks the article showing the requested post among replies', () => {
    document.body.innerHTML = `
      <article data-testid="tweet"><a href="/a/status/1"><time datetime="2024-01-01T00:00:00Z">x</time></a></article>
      <article data-testid="tweet"><a href="/jack/status/20"><time datetime="2006-03-21T20:50:14.000Z">x</time></a></article>`
    expect(articlePermalink(findArticleForPost(document, '20')!)?.id).toBe('20')
    expect(findArticleForPost(document, '999')).toBeNull()
  })
})
