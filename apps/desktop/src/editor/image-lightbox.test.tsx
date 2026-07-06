import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageLightbox, type LightboxImage } from './image-lightbox'
import { setPlatformSurface } from '@/lib/platform-surface'

function installMatchMedia(reducedMotion: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string): MediaQueryList => ({
      matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

function makeImage(): LightboxImage {
  return {
    src: 'asset://cat.png',
    alt: 'Cat',
    openPath: 'assets/cat.png',
    openImage: vi.fn(async () => {}),
    transitionName: 'reflect-image-lightbox-1',
  }
}

interface RenderedLightbox {
  onClose: ReturnType<typeof vi.fn>
  preview: HTMLElement
  image: HTMLImageElement
  backdrop: HTMLElement | null
  closeChrome: HTMLElement
}

function renderMobileLightbox(): RenderedLightbox {
  setPlatformSurface({ mobileApp: true })
  const onClose = vi.fn()
  render(<ImageLightbox image={makeImage()} onClose={onClose} onOpenImage={vi.fn()} />)

  const dialog = screen.getByRole('dialog', { name: 'Image preview' })
  const preview = screen.getByRole('button', { name: 'Close image preview' })
  const image = preview.querySelector('img')
  if (!(image instanceof HTMLImageElement)) {
    throw new Error('lightbox image missing')
  }
  const closeChrome = screen.getByRole('button', { name: 'Close' }).parentElement
  if (!(closeChrome instanceof HTMLElement)) {
    throw new Error('close chrome missing')
  }
  return {
    onClose,
    preview,
    image,
    backdrop: dialog.querySelector('.bg-black'),
    closeChrome,
  }
}

function firePointer(element: Element, type: string, init: Record<string, unknown>): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, init)
  act(() => {
    element.dispatchEvent(event)
  })
}

function touchDown(element: Element, clientX: number, clientY: number): void {
  firePointer(element, 'pointerdown', {
    pointerId: 1,
    isPrimary: true,
    pointerType: 'touch',
    clientX,
    clientY,
  })
}

beforeEach(() => {
  installMatchMedia(false)
  Element.prototype.getAnimations = vi.fn(() => [])
})

afterEach(() => {
  cleanup()
  setPlatformSurface({ touchEditor: false, mobileApp: false })
  vi.restoreAllMocks()
})

describe('ImageLightbox mobile drag-to-dismiss', () => {
  it('rebases at activation and follows the finger on both axes', () => {
    const { preview, image } = renderMobileLightbox()

    touchDown(preview, 180, 120)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 182, clientY: 180 })
    expect(image.style.transform).toContain('translate3d(0px, 0px, 0)')

    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 190, clientY: 260 })
    expect(image.style.transform).toContain('translate3d(8px, 80px, 0)')
  })

  it('fades the backdrop and chrome with drag progress', () => {
    const { preview, backdrop, closeChrome } = renderMobileLightbox()
    expect(backdrop).not.toBeNull()

    touchDown(preview, 180, 120)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 182, clientY: 180 })
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 190, clientY: 260 })

    const progress = Math.hypot(8, 80) / (window.innerHeight * 0.5)
    expect(Number.parseFloat(backdrop!.style.opacity)).toBeCloseTo(1 - progress * 0.85, 5)
    expect(Number.parseFloat(closeChrome.style.opacity)).toBeCloseTo(1 - progress * 2, 5)
    expect(closeChrome.style.pointerEvents).toBe('none')
  })

  it('dismisses past the distance threshold, sliding out along the drag vector', () => {
    const { preview, image, backdrop, onClose } = renderMobileLightbox()

    touchDown(preview, 180, 120)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 182, clientY: 180 })
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 190, clientY: 260 })
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 190, clientY: 320 })

    expect(image.style.transform).toContain(`, ${window.innerHeight}px, 0) scale(0.9)`)
    expect(backdrop!.style.opacity).toBe('0')
    expect(onClose).not.toHaveBeenCalled()
    onClose.mockImplementation(() => {
      expect(image.style.transform).toBe('')
    })

    fireEvent.transitionEnd(image)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('dismisses horizontally past the distance threshold', () => {
    const { preview, image, onClose } = renderMobileLightbox()

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 120, clientY: 100 })
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 340, clientY: 104 })
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 340, clientY: 104 })

    expect(image.style.transform).toContain(`translate3d(${window.innerWidth}px, `)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.transitionEnd(image)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('dismisses a fast flick before the distance threshold', () => {
    const { preview, image, onClose } = renderMobileLightbox()
    const nowSpy = vi.spyOn(performance, 'now')

    nowSpy.mockReturnValue(1_000)
    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 100, clientY: 120 })

    nowSpy.mockReturnValue(1_040)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 100, clientY: 170 })

    nowSpy.mockReturnValue(1_060)
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 100, clientY: 180 })
    nowSpy.mockRestore()

    expect(image.style.transform).toContain(`, ${window.innerHeight}px, 0)`)
    fireEvent.transitionEnd(image)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('springs back after a short drag and suppresses the trailing tap', () => {
    const { preview, image, backdrop, onClose } = renderMobileLightbox()

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 102, clientY: 130 })
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 102, clientY: 160 })
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 102, clientY: 160 })

    expect(image.style.transform).toBe('translate3d(0, 0, 0) scale(1)')
    expect(backdrop!.style.opacity).toBe('1')

    fireEvent.click(preview)
    fireEvent.click(preview)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.transitionEnd(image)
    fireEvent.click(preview)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('dismisses upward past the distance threshold', () => {
    const { preview, image, onClose } = renderMobileLightbox()

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 100, clientY: 80 })
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 100, clientY: -120 })

    expect(image.style.transform).toContain('translate3d(0px, -200px, 0)')

    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 100, clientY: -120 })
    expect(image.style.transform).toContain(`, -${window.innerHeight}px, 0)`)
    fireEvent.transitionEnd(image)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('snaps back without closing when the drag is interrupted', () => {
    const { preview, image, onClose } = renderMobileLightbox()

    touchDown(preview, 180, 120)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 182, clientY: 180 })
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 182, clientY: 380 })
    firePointer(preview, 'pointercancel', { pointerId: 1, clientX: 182, clientY: 380 })

    expect(image.style.transform).toBe('translate3d(0, 0, 0) scale(1)')
    fireEvent.transitionEnd(image)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('springs back after a short horizontal drag and suppresses the trailing tap', () => {
    const { preview, image, onClose } = renderMobileLightbox()

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 140, clientY: 102 })
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 140, clientY: 102 })

    expect(image.style.transform).toBe('translate3d(0, 0, 0) scale(1)')

    fireEvent.click(preview)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(preview)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.transitionEnd(image)
    fireEvent.click(preview)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('skips the settle animation under reduced motion and clears suppression', () => {
    installMatchMedia(true)
    const { preview, image, onClose } = renderMobileLightbox()

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 102, clientY: 130 })
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 102, clientY: 130 })

    expect(image.style.transform).toBe('')

    fireEvent.click(preview)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(preview)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still closes on a plain tap', () => {
    const { preview, onClose } = renderMobileLightbox()

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.click(preview)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ImageLightbox desktop surface', () => {
  it('ignores touch drags and closes on click without a drag backdrop', () => {
    const onClose = vi.fn()
    render(<ImageLightbox image={makeImage()} onClose={onClose} onOpenImage={vi.fn()} />)

    const dialog = screen.getByRole('dialog', { name: 'Image preview' })
    expect(dialog.querySelector('.bg-black')).toBeNull()
    expect(dialog.className).toContain('bg-black/80')

    const preview = screen.getByRole('button', { name: 'Close image preview' })
    const image = preview.querySelector('img')
    expect(image?.className).toContain('max-h-full max-w-full')

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 100, clientY: 200 })
    expect(image?.style.transform).toBe('')

    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 100, clientY: 200 })
    fireEvent.click(preview)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
