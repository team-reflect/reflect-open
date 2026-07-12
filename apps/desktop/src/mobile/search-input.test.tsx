import { useState, type ReactElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SearchInput } from './search-input'

afterEach(() => {
  cleanup()
})

describe('SearchInput', () => {
  it('blurs the field on the return key (dismissing the iOS keyboard)', () => {
    const { getByLabelText } = render(
      <SearchInput aria-label="Search" value="" onValueChange={vi.fn()} />,
    )
    const input = getByLabelText('Search') as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(document.activeElement).not.toBe(input)
  })

  it('leaves the field focused for other keys', () => {
    const { getByLabelText } = render(
      <SearchInput aria-label="Search" value="" onValueChange={vi.fn()} />,
    )
    const input = getByLabelText('Search') as HTMLInputElement
    input.focus()
    fireEvent.keyDown(input, { key: 'a' })
    expect(document.activeElement).toBe(input)
  })

  it('runs a caller-supplied onKeyDown after dismissing', () => {
    const onKeyDown = vi.fn()
    const { getByLabelText } = render(
      <SearchInput
        aria-label="Search"
        value=""
        onValueChange={vi.fn()}
        onKeyDown={onKeyDown}
      />,
    )
    const input = getByLabelText('Search')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
  })

  it('is a search-typed input', () => {
    const { getByLabelText } = render(
      <SearchInput aria-label="Search" value="" onValueChange={vi.fn()} />,
    )
    expect(getByLabelText('Search').getAttribute('type')).toBe('search')
  })

  it('shows the clear action only while the search has text', async () => {
    const user = userEvent.setup()
    const { getByRole, queryByRole } = render(<SearchInputHarness />)

    expect(queryByRole('button', { name: 'Clear search' })).toBeNull()
    await user.type(getByRole('searchbox', { name: 'Search' }), 'notes')
    expect(getByRole('button', { name: 'Clear search' })).toBeTruthy()

    await user.click(getByRole('button', { name: 'Clear search' }))
    expect((getByRole('searchbox', { name: 'Search' }) as HTMLInputElement).value).toBe('')
    expect(queryByRole('button', { name: 'Clear search' })).toBeNull()
  })

  it('keeps the search field focused when the clear action is tapped', async () => {
    const user = userEvent.setup()
    const { getByRole } = render(<SearchInputHarness initialValue="notes" />)
    const input = getByRole('searchbox', { name: 'Search' })
    input.focus()

    await user.click(getByRole('button', { name: 'Clear search' }))

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
