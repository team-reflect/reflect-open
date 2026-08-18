import { describe, expect, it } from 'vitest'
import {
  effectiveAnnotationListHeight,
  effectivePreviewPanelWidth,
  effectiveSidebarWidths,
} from './use-sidebar-resize'

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

describe('effectivePreviewPanelWidth', () => {
  it('honors the preference while the viewport leaves the editor its reserve', () => {
    // 1600 - 360 editor reserve - 260 - 320 rails = 660 room: the 380
    // preference fits untouched.
    expect(effectivePreviewPanelWidth(1600, 260, 320, 380)).toBe(380)
  })

  it('caps the pane at what the rails leave after the editor reserve', () => {
    // 1280 - 360 - 260 - 320 = 340 room: the 380 preference shrinks to fit
    // without touching the editor's 360.
    expect(effectivePreviewPanelWidth(1280, 260, 320, 380)).toBe(340)
  })

  it('counts the context rail only where the viewport shows it', () => {
    // Below the 1024px breakpoint the context aside is hidden, so the pane
    // inherits the whole main column; at 1024 the 320px rail counts again.
    expect(effectivePreviewPanelWidth(1000, 260, 320, 380)).toBe(380)
    expect(effectivePreviewPanelWidth(1024, 260, 320, 380)).toBe(320)
  })

  it('never shrinks below its range minimum — the editor gives way instead', () => {
    // Two 480px rails on a 1280px window leave 80px after the editor reserve;
    // the pane floors at 320 and the editor concedes the rest.
    expect(effectivePreviewPanelWidth(1280, 480, 480, 380)).toBe(320)
  })
})

describe('effectiveAnnotationListHeight', () => {
  it('honors the preference while the window leaves the PDF viewport its reserve', () => {
    expect(effectiveAnnotationListHeight(800, 180)).toBe(180)
  })

  it('caps the list at what the viewport leaves after the PDF reserve', () => {
    // 400 - 160 reserve = 240 room: the 480 preference shrinks to fit.
    expect(effectiveAnnotationListHeight(400, 480)).toBe(240)
  })

  it('never shrinks below its minimum — the PDF viewport gives way instead', () => {
    // 250 - 160 = 90 room: the list floors at 120 and the viewport concedes.
    expect(effectiveAnnotationListHeight(250, 480)).toBe(120)
  })

  it('clamps out-of-range preferences before budgeting', () => {
    expect(effectiveAnnotationListHeight(800, 900)).toBe(480)
    expect(effectiveAnnotationListHeight(800, 40)).toBe(120)
  })
})
