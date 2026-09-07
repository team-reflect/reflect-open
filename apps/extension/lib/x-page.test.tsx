import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { readXArticle, watchXActions } from './x-page'

let cleanup = () => {}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function fixture(): HTMLElement {
  document.body.innerHTML = `
    <article>
      <a href="https://x.com/example">Example</a><a href="https://x.com/example">@example</a>
      <a href="https://x.com/example/status/123"><time>Today</time></a>
      <div class="whitespace-pre-wrap" style="white-space: pre-wrap">First line\nSecond <span>line</span></div>
      <article>
        <a href="https://x.com/quoted">Quoted</a><a href="https://x.com/quoted">@quoted</a>
        <a href="https://x.com/quoted/status/456"><time>Yesterday</time></a>
        <div class="whitespace-pre-wrap line-clamp-5">A quoted post</div>
        <button aria-label="Like" aria-pressed="false">Quote like</button>
      </article>
      <button aria-label="Bookmark" aria-pressed="false">Bookmark</button>
    </article>`
  const article = document.querySelector('article')
  if (!article) throw new Error('article missing')
  return article
}

it('preserves observed rendered line breaks and keeps the nested quote separate', () => {
  const article = fixture()
  expect(readXArticle(article)).toEqual({
    id: '123',
    author: { name: 'Example', handle: 'example' },
    text: { value: 'First line\nSecond line', complete: true },
    quote: {
      id: '456',
      author: { name: 'Quoted', handle: 'quoted' },
      text: { value: 'A quoted post', complete: false },
    },
  })
})

it('ignores selected icons and unrelated mutations, then captures a confirmed user action once', async () => {
  fixture()
  const capture = vi.fn()
  const button = document.querySelector('button[aria-label="Bookmark"]')
  if (!button) throw new Error('button missing')
  button.setAttribute('aria-pressed', 'true')
  cleanup = watchXActions(capture)
  document.body.append(document.createElement('div'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(capture).not.toHaveBeenCalled()
  button.setAttribute('aria-pressed', 'false')
  button.addEventListener('click', () => button.setAttribute('aria-pressed', 'true'))
  await userEvent.click(page.getByRole('button', { name: 'Bookmark' }))
  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
  expect(capture).toHaveBeenCalledWith(expect.objectContaining({ id: '123' }), 'bookmark')
})

it('stops observing after cleanup and a replacement watcher handles keyboard activation once', async () => {
  fixture()
  const oldCapture = vi.fn()
  watchXActions(oldCapture)()
  const capture = vi.fn()
  cleanup = watchXActions(capture)
  const button = document.querySelector('button[aria-label="Bookmark"]')
  if (!(button instanceof HTMLButtonElement)) throw new Error('button missing')
  button.addEventListener('click', () => button.setAttribute('aria-pressed', 'true'))
  button.focus()
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
  expect(oldCapture).not.toHaveBeenCalled()
})
