import { useState, type ReactElement } from 'react'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import { expectLocatorToHaveCount } from '@/test-utils/expect'
import { SearchInput } from './search-input'

describe('SearchInput', () => {
  it('blurs the field on the return key (dismissing the iOS keyboard)', async () => {
    const view = await render(
      <SearchInput aria-label="Search" value="" onValueChange={vi.fn()} />,
    )
    const input = view.getByLabelText('Search').element() as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)
    await userEvent.keyboard('{Enter}')
    expect(document.activeElement).not.toBe(input)
  })

  it('leaves the field focused for other keys', async () => {
    const view = await render(
      <SearchInput aria-label="Search" value="" onValueChange={vi.fn()} />,
    )
    const input = view.getByLabelText('Search').element() as HTMLInputElement
    input.focus()
    await userEvent.keyboard('a')
    expect(document.activeElement).toBe(input)
  })

  it('runs a caller-supplied onKeyDown after dismissing', async () => {
    const onKeyDown = vi.fn()
    const view = await render(
      <SearchInput
        aria-label="Search"
        value=""
        onValueChange={vi.fn()}
        onKeyDown={onKeyDown}
      />,
    )
    const input = view.getByLabelText('Search').element() as HTMLInputElement
    input.focus()
    await userEvent.keyboard('{Enter}')
    expect(onKeyDown).toHaveBeenCalledTimes(1)
  })

  it('is a search-typed input', async () => {
    const view = await render(
      <SearchInput aria-label="Search" value="" onValueChange={vi.fn()} />,
    )
    await expect.element(view.getByLabelText('Search')).toHaveAttribute('type', 'search')
  })

  it('shows the clear action only while the search has text', async () => {
    const view = await render(<SearchInputHarness />)

    expect(view.getByRole('button', { name: 'Clear search' }).query()).toBeNull()
    await view.getByRole('searchbox', { name: 'Search' }).fill('notes')
    await expect.element(view.getByRole('button', { name: 'Clear search' })).toBeInTheDocument()

    await view.getByRole('button', { name: 'Clear search' }).click()
    await expect.element(view.getByRole('searchbox', { name: 'Search' })).toHaveValue('')
    await expectLocatorToHaveCount(view.getByRole('button', { name: 'Clear search' }), 0)
  })

  it('keeps the search field focused when the clear action is tapped', async () => {
    const view = await render(<SearchInputHarness initialValue="notes" />)
    const input = view.getByRole('searchbox', { name: 'Search' }).element() as HTMLInputElement
    input.focus()

    await view.getByRole('button', { name: 'Clear search' }).click()

    expect(document.activeElement).toBe(input)
  })
})

function SearchInputHarness({ initialValue = '' }: { initialValue?: string }): ReactElement {
  const [value, setValue] = useState(initialValue)
  return (
    <SearchInput
      aria-label="Search"
      value={value}
      onValueChange={setValue}
    />
  )
}
