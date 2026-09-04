// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { messageForChange } from './report'

function article(html: string): Element {
  const container = document.createElement('div')
  container.innerHTML = `<article data-testid="tweet">${html}</article>`
  return container.firstElementChild!
}

describe('messageForChange', () => {
  it('reports a bookmark with the post read off the article and its own permalink', () => {
    const message = messageForChange({
      article: article(
        `<a href="/jack/status/20"><time datetime="2006-03-21T20:50:14.000Z">x</time></a><div data-testid="tweetText">hi</div>`,
      ),
      id: '20',
      action: 'bookmark',
      active: true,
    })
    expect(message).toEqual({
      type: 'reflect:post-captured',
      page: {
        url: 'https://x.com/jack/status/20',
        title: '',
        post: {
          provider: 'x',
          id: '20',
          trigger: 'bookmark',
          author: { name: 'jack', handle: 'jack' },
          text: 'hi',
          postedAt: '2006-03-21T20:50:14.000Z',
        },
      },
    })
  })

  it('still captures by id when the article cannot be read', () => {
    const message = messageForChange({
      article: article('<div>nothing recognizable</div>'),
      id: '20',
      action: 'like',
      active: true,
    })
    expect(message).toEqual({
      type: 'reflect:post-captured',
      page: {
        url: 'https://x.com/i/status/20',
        title: '',
        post: { provider: 'x', id: '20', trigger: 'like' },
      },
    })
  })

  it('reports a release by id', () => {
    expect(
      messageForChange({ article: article(''), id: '20', action: 'bookmark', active: false }),
    ).toEqual({ type: 'reflect:post-released', id: '20' })
  })
})
