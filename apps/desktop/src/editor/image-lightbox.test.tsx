import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { ImageLightbox, type LightboxImage } from './image-lightbox'
import { setPlatformSurface } from '@/lib/platform-surface'

// The Playwright context pins prefers-reduced-motion to reduce, so the
// reduced-motion query stays stubbed to exercise both settings.
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

async function renderMobileLightbox(): Promise<RenderedLightbox> {
  setPlatformSurface({ mobileApp: true })
  const onClose = vi.fn()
  await render(<ImageLightbox image={makeImage()} onClose={onClose} onOpenImage={vi.fn()} />)

  const dialog = page.getByRole('dialog', { name: 'Image preview' })
  await expect.element(dialog).toBeInTheDocument()
  const preview = page.getByRole('button', { name: 'Close image preview' }).element()
  if (!(preview instanceof HTMLElement)) {
    throw new Error('lightbox preview missing')
  }
  const image = preview.querySelector('img')
  if (!(image instanceof HTMLImageElement)) {
    throw new Error('lightbox image missing')
  }
  const closeChrome = page.getByRole('button', { name: 'Close', exact: true }).element()
    .parentElement
  if (!(closeChrome instanceof HTMLElement)) {
    throw new Error('close chrome missing')
  }
  // Let the dialog's enter animation finish so drag activation samples the
  // settled full-viewport rect, not a mid-zoom one.
  await vi.waitFor(() => {
    expect(preview.getBoundingClientRect().height).toBe(window.innerHeight)
  })
  const backdrop = dialog.element().querySelector('.bg-black')
  return {
    onClose,
    preview,
    image,
    backdrop: backdrop instanceof HTMLElement ? backdrop : null,
    closeChrome,
  }
}

function firePointer(element: Element, type: string, init: PointerEventInit): void {
  element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }))
}

function fireClick(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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

// The app stylesheet collapses transitions to 0.01ms under the context's
// pinned reduced motion, so the real transitionend would land before the
// settle assertions can observe the settling styles; swallowing it lets the
// hook's fallback timer complete each settle at its scripted duration.
function swallowTransitionEnd(event: Event): void {
  event.stopPropagation()
}

beforeEach(() => {
  installMatchMedia(false)
  document.addEventListener('transitionend', swallowTransitionEnd, { capture: true })
})

afterEach(() => {
  document.removeEventListener('transitionend', swallowTransitionEnd, { capture: true })
  setPlatformSurface({ touchEditor: false, mobileApp: false })
  vi.restoreAllMocks()
})

describe('ImageLightbox mobile drag-to-dismiss', () => {
  it('rebases at activation and follows the finger on both axes', async () => {
    const { preview, image } = await renderMobileLightbox()

    touchDown(preview, 180, 120)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 182, clientY: 180 })
    await vi.waitFor(() => {
      expect(image.style.transform).toContain('translate3d(0px, 0px, 0px)')
    })

    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 190, clientY: 260 })
    await vi.waitFor(() => {
      expect(image.style.transform).toContain('translate3d(8px, 80px, 0px)')
    })
  })

  it('fades the backdrop and chrome with drag progress', async () => {
    const { preview, backdrop, closeChrome } = await renderMobileLightbox()
    expect(backdrop).not.toBeNull()

    touchDown(preview, 180, 120)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 182, clientY: 180 })
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 190, clientY: 260 })

    const progress = Math.hypot(8, 80) / (window.innerHeight * 0.5)
    await vi.waitFor(() => {
      expect(Number.parseFloat(backdrop!.style.opacity)).toBeCloseTo(1 - progress * 0.85, 5)
    })
    expect(Number.parseFloat(closeChrome.style.opacity)).toBeCloseTo(1 - progress * 2, 5)
    expect(closeChrome.style.pointerEvents).toBe('none')
  })

  it('dismisses past the distance threshold, sliding out along the drag vector', async () => {
    const { preview, image, backdrop, onClose } = await renderMobileLightbox()

    touchDown(preview, 180, 120)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 182, clientY: 180 })
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 190, clientY: 260 })
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 190, clientY: 320 })

    await vi.waitFor(() => {
      expect(image.style.transform).toContain(`, ${window.innerHeight}px, 0px) scale(0.9)`)
    })
    expect(backdrop!.style.opacity).toBe('0')
    expect(onClose).not.toHaveBeenCalled()
    onClose.mockImplementation(() => {
      expect(image.style.transform).toBe('')
    })

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 5_000 })
  })

  it('dismisses horizontally past the distance threshold', async () => {
    const { preview, image, onClose } = await renderMobileLightbox()

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 120, clientY: 100 })
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 340, clientY: 104 })
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 340, clientY: 104 })

    await vi.waitFor(() => {
      expect(image.style.transform).toContain(`translate3d(${window.innerWidth}px, `)
    })
    expect(onClose).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 5_000 })
  })

  it('dismisses a fast flick before the distance threshold', async () => {
    const { preview, image, onClose } = await renderMobileLightbox()
    const nowSpy = vi.spyOn(performance, 'now')

    nowSpy.mockReturnValue(1_000)
    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 100, clientY: 120 })

    nowSpy.mockReturnValue(1_040)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 100, clientY: 170 })

    nowSpy.mockReturnValue(1_060)
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 100, clientY: 180 })
    nowSpy.mockRestore()

    await vi.waitFor(() => {
      expect(image.style.transform).toContain(`, ${window.innerHeight}px, 0px)`)
    })
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 5_000 })
  })

  it('springs back after a short drag and suppresses the trailing tap', async () => {
    const { preview, image, backdrop, onClose } = await renderMobileLightbox()

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 102, clientY: 130 })
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 102, clientY: 160 })
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 102, clientY: 160 })

    await vi.waitFor(() => {
      expect(image.style.transform).toBe('translate3d(0px, 0px, 0px) scale(1)')
    })
    expect(backdrop!.style.opacity).toBe('1')

    fireClick(preview)
    fireClick(preview)
    expect(onClose).not.toHaveBeenCalled()

    await vi.waitFor(() => {
      expect(image.style.transform).toBe('')
    })
    fireClick(preview)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('dismisses upward past the distance threshold', async () => {
    const { preview, image, onClose } = await renderMobileLightbox()

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 100, clientY: 80 })
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 100, clientY: -120 })

    await vi.waitFor(() => {
      expect(image.style.transform).toContain('translate3d(0px, -200px, 0px)')
    })

    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 100, clientY: -120 })
    await vi.waitFor(() => {
      expect(image.style.transform).toContain(`, -${window.innerHeight}px, 0px)`)
    })
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 5_000 })
  })

  it('snaps back without closing when the drag is interrupted', async () => {
    const { preview, image, onClose } = await renderMobileLightbox()

    touchDown(preview, 180, 120)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 182, clientY: 180 })
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 182, clientY: 380 })
    firePointer(preview, 'pointercancel', { pointerId: 1, clientX: 182, clientY: 380 })

    await vi.waitFor(() => {
      expect(image.style.transform).toBe('translate3d(0px, 0px, 0px) scale(1)')
    })
    await vi.waitFor(() => {
      expect(image.style.transform).toBe('')
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('springs back after a short horizontal drag and suppresses the trailing tap', async () => {
    const { preview, image, onClose } = await renderMobileLightbox()

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 140, clientY: 102 })
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 140, clientY: 102 })

    await vi.waitFor(() => {
      expect(image.style.transform).toBe('translate3d(0px, 0px, 0px) scale(1)')
    })

    fireClick(preview)
    expect(onClose).not.toHaveBeenCalled()

    fireClick(preview)
    expect(onClose).not.toHaveBeenCalled()

    await vi.waitFor(() => {
      expect(image.style.transform).toBe('')
    })
    fireClick(preview)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('skips the settle animation under reduced motion and clears suppression', async () => {
    installMatchMedia(true)
    const { preview, image, onClose } = await renderMobileLightbox()

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 102, clientY: 130 })
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 102, clientY: 130 })

    expect(image.style.transform).toBe('')

    fireClick(preview)
    expect(onClose).not.toHaveBeenCalled()
    fireClick(preview)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still closes on a plain tap', async () => {
    const { preview, onClose } = await renderMobileLightbox()

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 100, clientY: 100 })
    fireClick(preview)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ImageLightbox desktop surface', () => {
  it('ignores touch drags and closes on click without a drag backdrop', async () => {
    const onClose = vi.fn()
    await render(<ImageLightbox image={makeImage()} onClose={onClose} onOpenImage={vi.fn()} />)

    const dialogLocator = page.getByRole('dialog', { name: 'Image preview' })
    await expect.element(dialogLocator).toBeInTheDocument()
    const dialog = dialogLocator.element()
    expect(dialog.querySelector('.bg-black')).toBeNull()
    expect(dialog.className).toContain('bg-black/80')

    const preview = page.getByRole('button', { name: 'Close image preview' }).element()
    const image = preview.querySelector('img')
    expect(image?.className).toContain('max-h-full max-w-full')

    touchDown(preview, 100, 100)
    firePointer(preview, 'pointermove', { pointerId: 1, clientX: 100, clientY: 200 })
    expect(image?.style.transform).toBe('')

    firePointer(preview, 'pointerup', { pointerId: 1, clientX: 100, clientY: 200 })
    fireClick(preview)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
