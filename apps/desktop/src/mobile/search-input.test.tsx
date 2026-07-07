import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SearchInput } from './search-input'

afterEach(() => {
  cleanup()
})

describe('SearchInput', () => {
  it('blurs the field on the return key (dismissing the iOS keyboard)', () => {
    const { getByLabelText } = render(<SearchInput aria-label="Search" />)
    const input = getByLabelText('Search') as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(document.activeElement).not.toBe(input)
  })

  it('leaves the field focused for other keys', () => {
    const { getByLabelText } = render(<SearchInput aria-label="Search" />)
    const input = getByLabelText('Search') as HTMLInputElement
    input.focus()
    fireEvent.keyDown(input, { key: 'a' })
    expect(document.activeElement).toBe(input)
  })

  it('runs a caller-supplied onKeyDown after dismissing', () => {
    const onKeyDown = vi.fn()
    const { getByLabelText } = render(<SearchInput aria-label="Search" onKeyDown={onKeyDown} />)
    const input = getByLabelText('Search')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
  })

  it('is a search-typed input', () => {
    const { getByLabelText } = render(<SearchInput aria-label="Search" />)
    expect(getByLabelText('Search').getAttribute('type')).toBe('search')
  })
})
