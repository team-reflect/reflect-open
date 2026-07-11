import { describe, expect, it } from 'vitest'
import { effectiveSidebarWidths } from './use-sidebar-resize'

describe('effectiveSidebarWidths', () => {
  it('honors both preferences when the viewport has room', () => {
    expect(effectiveSidebarWidths(1600, 480, 480)).toEqual({ workspace: 480, context: 480 })
    expect(effectiveSidebarWidths(1024, 260, 320)).toEqual({ workspace: 260, context: 320 })
  })

  it('scales both rails proportionally when they cannot both fit', () => {
    // 1024 - 360 editor reserve = a 664px budget for 960px of preferences.
    expect(effectiveSidebarWidths(1024, 480, 480)).toEqual({ workspace: 332, context: 332 })
  })

  it('ignores the context rail below its CSS breakpoint', () => {
    // At 1000px the context aside is hidden, so the workspace keeps its
    // preference and the context width passes through for when it returns.
    expect(effectiveSidebarWidths(1000, 480, 400)).toEqual({ workspace: 480, context: 400 })
  })

  it('never shrinks a rail below its range minimum', () => {
    // A 500px window leaves a 140px budget; the rail floors at its 200px
    // minimum and the editor gives way instead.
    expect(effectiveSidebarWidths(500, 480, 480)).toEqual({ workspace: 200, context: 480 })
  })

  it('clamps out-of-range preferences before budgeting', () => {
    expect(effectiveSidebarWidths(1600, 9000, 100)).toEqual({ workspace: 480, context: 240 })
  })
})
