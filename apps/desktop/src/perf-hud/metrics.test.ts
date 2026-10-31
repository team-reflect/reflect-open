import { describe, expect, it } from 'vitest'
import { getPercentile, measureGesture } from '@/perf-hud/metrics.ts'

function steady(count: number, step: number, from = 0): number[] {
  return Array.from({ length: count }, (_, i) => from + i * step)
}

describe('measureGesture', () => {
  it('reports no hitch time for a steady 60 Hz run', () => {
    const result = measureGesture(steady(61, 16.7), [4, 5, 6], 16.7)
    expect(result.frames).toBe(60)
    expect(result.fps).toBeCloseTo(59.9, 1)
    expect(result.hitchTimeRatio).toBeCloseTo(0)
    expect(result.p95InputLagMs).toBe(6)
  })

  it('adds the excess time of a dropped frame', () => {
    const times = [...steady(30, 16.7), ...steady(30, 16.7, 29 * 16.7 + 50)]
    const result = measureGesture(times, [], 16.7)
    expect(result.p95FrameMs).toBeCloseTo(16.7)
    expect(result.hitchTimeRatio).toBeCloseTo(((50 - 16.7) / result.durationMs) * 1000)
    expect(result.p95InputLagMs).toBeNull()
  })

  it('reports zeros for a gesture with no frames', () => {
    const result = measureGesture([], [], 16.7)
    expect(result).toMatchObject({ durationMs: 0, frames: 0, fps: 0, hitchTimeRatio: 0 })
  })
})

describe('getPercentile', () => {
  it('uses the nearest rank', () => {
    expect(getPercentile([4, 1, 3, 2], 0.95)).toBe(4)
    expect(getPercentile([4, 1, 3, 2], 0.5)).toBe(2)
    expect(getPercentile([], 0.5)).toBe(0)
  })
})
