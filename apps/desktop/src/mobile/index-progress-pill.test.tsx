import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setIndexProgress } from '@/lib/index-progress'
import { publishKeyboardHeight } from '@/mobile/use-keyboard'
import { IndexProgressPill } from './index-progress-pill'

/**
 * The "Preparing notes…" pill gates on the pass doing real work (`worked` =
 * files actually read), not on graph size: a reconcile sweeps the whole
 * listing on every open and resume, so `done`/`total` alone would show the
 * pill every single time even when everything skips read-free.
 */

beforeEach(() => {
  publishKeyboardHeight(0)
})

afterEach(() => {
  setIndexProgress(null)
  cleanup()
})

describe('IndexProgressPill', () => {
  it('stays hidden for a skip-everything pass, however large the graph', () => {
    setIndexProgress({ done: 3_500, total: 7_000, worked: 0 })
    render(<IndexProgressPill />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('appears once a pass has actually read enough files (a first index)', () => {
    setIndexProgress({ done: 160, total: 7_000, worked: 160 })
    render(<IndexProgressPill />)
    expect(screen.getByRole('status').textContent).toContain('160 of 7,000')
  })

  it('stays hidden below the work threshold — a routine sync of a few notes', () => {
    setIndexProgress({ done: 6_900, total: 7_000, worked: 40 })
    render(<IndexProgressPill />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stays hidden on a small graph even when every file is read', () => {
    setIndexProgress({ done: 90, total: 90, worked: 90 })
    render(<IndexProgressPill />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('yields to the keyboard', () => {
    setIndexProgress({ done: 500, total: 7_000, worked: 500 })
    publishKeyboardHeight(300)
    render(<IndexProgressPill />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
