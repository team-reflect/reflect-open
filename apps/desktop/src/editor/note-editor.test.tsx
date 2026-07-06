import { type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openUrl } from '@tauri-apps/plugin-opener'
import { dispatchDeepLink } from '@/lib/deep-links/intake'
import { NoteEditor } from './note-editor'
import { setPlatformSurface } from '@/lib/platform-surface'

/** Props the mocked `<MeowdownEditor>` captures so the test can drive its callbacks. */
interface CapturedEditorProps {
  mode?: 'hide' | 'focus' | 'show' | 'source'
  editorClassName?: string
  spellCheck?: boolean
  timeFormat?: '12' | '24'
  children?: ReactNode
  resolveImageUrl?: (src: string) => string | undefined
  onImageClick?: (payload: { src: string; alt: string; event: MouseEvent }) => void
  onLinkClick?: (payload: { href: string; event: MouseEvent }) => void
  onTagClick?: (payload: { tag: string; event: MouseEvent }) => void
  onFilePaste?: (file: File) => Promise<string | undefined>
  resolveFileLink?: (payload: { href: string; label: string; title: string }) => boolean
  resolveFileInfo?: (
    href: string,
  ) => { size: number } | undefined | Promise<{ size: number } | undefined>
  onFileClick?: (payload: { href: string; name: string; event: MouseEvent | KeyboardEvent }) => void
}

const captured = vi.hoisted(() => ({ props: null as CapturedEditorProps | null }))

/** The stub editor `useEditor` hands `EditorInputTraits` (see the mock below). */
const editorStub = vi.hoisted(() => ({
  mounted: true,
  view: { dom: document.createElement('div') },
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => {}),
}))

vi.mock('@/lib/deep-links/intake', () => ({
  dispatchDeepLink: vi.fn(),
}))

const openDeepLinkInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openDeepLinkInNewWindow,
}))

// Stub the editor: capture its props and render the image-preview DOM shape
// meowdown produces, so the source element lookup in `onImageClick` resolves.
// `useEditor` backs `EditorInputTraits` (mounted inside the editor).
vi.mock('@meowdown/react', () => ({
  useEditor: () => editorStub,
  MeowdownEditor: (props: CapturedEditorProps) => {
    captured.props = props
    return (
      <div className={props.editorClassName}>
        <span className="md-image-preview md-image-preview-img">
          <img
            src={props.resolveImageUrl?.('assets/cat.png') ?? ''}
            alt="Cat"
            data-testid="inline-image"
          />
        </span>
        {props.children}
      </div>
    )
  },
}))

function renderEditor(
  openAsset: (path: string) => Promise<void> | void = vi.fn(async () => {}),
): ReturnType<typeof render> {
  return render(
    <NoteEditor
      initialContent={'A photo\n\n![Cat](assets/cat.png)'}
      resolveImageUrl={(src) => (src === 'assets/cat.png' ? 'asset://cat.png' : null)}
      resolveAssetOpenPath={(src) =>
        src === 'assets/cat.png' ? 'assets/cat.png' : null
      }
      openAsset={openAsset}
    />,
  )
}

/** A click payload as meowdown's `onImageClick` would deliver it. */
function imageClick(src: string, alt: string): { src: string; alt: string; event: MouseEvent } {
  const image = screen.getByTestId('inline-image')
  const event = new MouseEvent('click', { bubbles: true })
  Object.defineProperty(event, 'target', { value: image, configurable: true })
  return { src, alt, event }
}

function installViewTransitionMock(): ReturnType<typeof vi.fn> {
  const startViewTransition = vi.fn((callback?: () => unknown): ViewTransition => {
    const update = callback?.()
    return {
      finished: Promise.resolve(),
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(update).then(() => undefined),
      skipTransition: vi.fn(),
      types: new Set<string>() as unknown as ViewTransitionTypeSet,
    }
  })
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    writable: true,
    value: startViewTransition,
  })
  return startViewTransition
}

function firePointer(element: Element, type: string, init: Record<string, unknown>): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, init)
  act(() => {
    element.dispatchEvent(event)
  })
}

beforeEach(() => {
  captured.props = null
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  Element.prototype.getAnimations = vi.fn(() => [])
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    writable: true,
    value: undefined,
  })
})

afterEach(() => {
  cleanup()
  setPlatformSurface({ touchEditor: false, mobileApp: false })
  vi.clearAllMocks()
})

describe('NoteEditor markdown syntax mode', () => {
  it('passes hide to meowdown by default', () => {
    renderEditor()
    expect(captured.props?.mode).toBe('hide')
  })

  it('passes an explicit markdown syntax mode to meowdown', () => {
    render(<NoteEditor initialContent="" markMode="show" />)
    expect(captured.props?.mode).toBe('show')
  })
})

describe('NoteEditor time format', () => {
  it('passes the 12-hour clock to meowdown by default', () => {
    renderEditor()
    expect(captured.props?.timeFormat).toBe('12')
  })

  it("maps the 24h setting to meowdown's 24-hour clock", () => {
    render(<NoteEditor initialContent="" timeFormat="24h" />)
    expect(captured.props?.timeFormat).toBe('24')
  })
})

describe('NoteEditor touch-surface input hygiene', () => {
  afterEach(() => {
    setPlatformSurface({ touchEditor: false })
    editorStub.mounted = true
    editorStub.view.dom = document.createElement('div')
  })

  it('passes the spellcheck setting through on desktop', () => {
    render(<NoteEditor initialContent="" spellCheck={true} />)
    expect(captured.props?.spellCheck).toBe(true)
  })

  it('pins spellcheck off on the touch surface (iOS smart-punctuation gate)', () => {
    setPlatformSurface({ touchEditor: true })
    render(<NoteEditor initialContent="" spellCheck={true} />)
    expect(captured.props?.spellCheck).toBe(false)
  })

  it('sets explicit input traits on the contenteditable on the touch surface', () => {
    setPlatformSurface({ touchEditor: true })
    render(<NoteEditor initialContent="" />)
    expect(editorStub.view.dom.getAttribute('autocapitalize')).toBe('sentences')
    expect(editorStub.view.dom.getAttribute('autocorrect')).toBe('on')
  })

  it('retries until the editor view mounts (traits are never silently skipped)', async () => {
    setPlatformSurface({ touchEditor: true })
    editorStub.mounted = false
    render(<NoteEditor initialContent="" />)
    expect(editorStub.view.dom.hasAttribute('autocapitalize')).toBe(false)

    editorStub.mounted = true
    await waitFor(() => {
      expect(editorStub.view.dom.getAttribute('autocapitalize')).toBe('sentences')
    })
  })

  it('leaves the contenteditable untouched on desktop', () => {
    render(<NoteEditor initialContent="" />)
    expect(editorStub.view.dom.hasAttribute('autocapitalize')).toBe(false)
    expect(editorStub.view.dom.hasAttribute('autocorrect')).toBe(false)
  })
})

describe('NoteEditor tag click', () => {
  it('forwards a clicked tag name, without the leading #', () => {
    const onTagClick = vi.fn()
    render(<NoteEditor initialContent="" onTagClick={onTagClick} />)
    expect(captured.props?.onTagClick).toBeTypeOf('function')

    const event = new MouseEvent('click', { bubbles: true })
    act(() => captured.props?.onTagClick?.({ tag: 'book', event }))
    expect(onTagClick).toHaveBeenCalledWith('book')
  })
})

describe('NoteEditor image lightbox', () => {
  it('opens a lightbox from an inline image and closes on Escape', async () => {
    renderEditor()
    expect(captured.props?.onImageClick).toBeTypeOf('function')

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    const dialog = await screen.findByRole('dialog', { name: 'Image preview' })
    const preview = dialog.querySelector('img')
    expect(preview).toBeInstanceOf(HTMLImageElement)
    expect(preview?.src).toBe('asset://cat.png')

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('uses the native View Transition API when available', async () => {
    const startViewTransition = installViewTransitionMock()
    renderEditor()

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('dialog', { name: 'Image preview' })).toBeInTheDocument()
  })

  it('opens a local image through the graph asset opener', async () => {
    const openImage = vi.fn(async () => {})
    renderEditor(openImage)

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    await userEvent.click(await screen.findByRole('button', { name: 'Open' }))
    expect(openImage).toHaveBeenCalledWith('assets/cat.png')
  })

  it('keeps the image opener inside iOS safe-area bounds', async () => {
    renderEditor()

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    const opener = await screen.findByRole('button', { name: 'Open' })
    expect(opener.parentElement?.className).toContain(
      'top-[max(env(safe-area-inset-top),1rem)]',
    )
    expect(opener.parentElement?.className).toContain(
      'right-[max(env(safe-area-inset-right),1rem)]',
    )
  })

  it('shows mobile close chrome inside iOS safe-area bounds', async () => {
    setPlatformSurface({ mobileApp: true })
    renderEditor()

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    const close = await screen.findByRole('button', { name: 'Close' })
    expect(close.parentElement?.className).toContain(
      'top-[max(env(safe-area-inset-top),1rem)]',
    )
    expect(close.parentElement?.className).toContain(
      'left-[max(env(safe-area-inset-left),1rem)]',
    )
    expect(screen.getByRole('button', { name: 'Close image preview' }).className).toContain(
      'bg-black',
    )
  })

  it('dismisses the mobile image lightbox with a downward drag', async () => {
    setPlatformSurface({ mobileApp: true })
    renderEditor()

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    const preview = await screen.findByRole('button', { name: 'Close image preview' })
    const image = preview.querySelector('img')
    expect(image).toBeInstanceOf(HTMLImageElement)

    firePointer(preview, 'pointerdown', {
      pointerId: 1,
      isPrimary: true,
      pointerType: 'touch',
      clientX: 180,
      clientY: 120,
    })
    firePointer(preview, 'pointermove', {
      pointerId: 1,
      clientX: 182,
      clientY: 180,
    })
    expect(image?.style.transform).toContain('translate3d(0, 60px, 0)')

    firePointer(preview, 'pointermove', {
      pointerId: 1,
      clientX: 184,
      clientY: 360,
    })
    firePointer(preview, 'pointerup', {
      pointerId: 1,
      clientX: 184,
      clientY: 360,
    })

    expect(image?.style.transform).toContain(`translate3d(0, ${window.innerHeight}px, 0)`)
    fireEvent.transitionEnd(image!)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('uses the release position when the final mobile drag move is coalesced', async () => {
    setPlatformSurface({ mobileApp: true })
    renderEditor()

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    const preview = await screen.findByRole('button', { name: 'Close image preview' })
    const image = preview.querySelector('img')
    expect(image).toBeInstanceOf(HTMLImageElement)

    firePointer(preview, 'pointerdown', {
      pointerId: 1,
      isPrimary: true,
      pointerType: 'touch',
      clientX: 180,
      clientY: 120,
    })
    firePointer(preview, 'pointermove', {
      pointerId: 1,
      clientX: 182,
      clientY: 180,
    })
    firePointer(preview, 'pointerup', {
      pointerId: 1,
      clientX: 184,
      clientY: 360,
    })

    expect(image?.style.transform).toContain(`translate3d(0, ${window.innerHeight}px, 0)`)
    fireEvent.transitionEnd(image!)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('snaps the mobile lightbox back after a short drag without tap-closing it', async () => {
    setPlatformSurface({ mobileApp: true })
    renderEditor()

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    const preview = await screen.findByRole('button', { name: 'Close image preview' })
    const image = preview.querySelector('img')
    expect(image).toBeInstanceOf(HTMLImageElement)

    firePointer(preview, 'pointerdown', {
      pointerId: 1,
      isPrimary: true,
      pointerType: 'touch',
      clientX: 180,
      clientY: 120,
    })
    firePointer(preview, 'pointermove', {
      pointerId: 1,
      clientX: 182,
      clientY: 150,
    })
    firePointer(preview, 'pointerup', {
      pointerId: 1,
      clientX: 182,
      clientY: 150,
    })

    expect(image?.style.transform).toBe('translate3d(0, 0, 0) scale(1)')
    fireEvent.click(preview)
    expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeInTheDocument()
    fireEvent.click(preview)
    expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeInTheDocument()

    fireEvent.transitionEnd(image!)
    fireEvent.click(preview)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('clears mobile drag click suppression when reduced motion skips the snap animation', async () => {
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string): MediaQueryList => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    setPlatformSurface({ mobileApp: true })
    renderEditor()

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    const preview = await screen.findByRole('button', { name: 'Close image preview' })
    try {
      firePointer(preview, 'pointerdown', {
        pointerId: 1,
        isPrimary: true,
        pointerType: 'touch',
        clientX: 180,
        clientY: 120,
      })
      firePointer(preview, 'pointermove', {
        pointerId: 1,
        clientX: 182,
        clientY: 150,
      })
      firePointer(preview, 'pointerup', {
        pointerId: 1,
        clientX: 182,
        clientY: 150,
      })

      fireEvent.click(preview)
      expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeInTheDocument()
      fireEvent.click(preview)
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      })
    }
  })

  it('uses the opener captured when the lightbox opens', async () => {
    const firstOpenImage = vi.fn(async () => {})
    const secondOpenImage = vi.fn(async () => {})
    const view = renderEditor(firstOpenImage)

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))
    await screen.findByRole('dialog', { name: 'Image preview' })

    view.rerender(
      <NoteEditor
        initialContent={'A photo\n\n![Cat](assets/cat.png)'}
        resolveImageUrl={(src) => (src === 'assets/cat.png' ? 'asset://cat.png' : null)}
        resolveAssetOpenPath={(src) => (src === 'assets/cat.png' ? 'assets/cat.png' : null)}
        openAsset={secondOpenImage}
      />,
    )

    await userEvent.click(await screen.findByRole('button', { name: 'Open' }))
    expect(firstOpenImage).toHaveBeenCalledWith('assets/cat.png')
    expect(secondOpenImage).not.toHaveBeenCalled()
  })

  it('hides the Open button when no opener is provided', async () => {
    render(
      <NoteEditor
        initialContent={'A photo\n\n![Cat](assets/cat.png)'}
        resolveImageUrl={(src) => (src === 'assets/cat.png' ? 'asset://cat.png' : null)}
        resolveAssetOpenPath={(src) => (src === 'assets/cat.png' ? 'assets/cat.png' : null)}
      />,
    )

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    expect(await screen.findByRole('dialog', { name: 'Image preview' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
  })

  it('does not open a lightbox when the source cannot be resolved', () => {
    renderEditor()

    act(() => captured.props?.onImageClick?.(imageClick('https://blocked.example/x.png', 'X')))

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('NoteEditor link opening', () => {
  it('opens external links via onLinkClick', () => {
    renderEditor()
    expect(captured.props?.onLinkClick).toBeTypeOf('function')

    const event = new MouseEvent('click')
    act(() => captured.props?.onLinkClick?.({ href: 'https://example.com', event }))

    expect(openUrl).toHaveBeenCalledWith('https://example.com')
  })

  it('opens a custom app scheme link via the URL opener', () => {
    renderEditor()

    const event = new MouseEvent('click')
    act(() =>
      captured.props?.onLinkClick?.({ href: 'x-devonthink-item://40C88434-68B6-4DCB', event }),
    )

    expect(openUrl).toHaveBeenCalledWith('x-devonthink-item://40C88434-68B6-4DCB')
  })

  it('drops an unsafe scheme link without opening anything', () => {
    renderEditor()

    const event = new MouseEvent('click')
    act(() => captured.props?.onLinkClick?.({ href: 'file:///etc/passwd', event }))

    expect(openUrl).not.toHaveBeenCalled()
    expect(dispatchDeepLink).not.toHaveBeenCalled()
  })

  it('opens an assets/ link through the graph asset opener, not the URL opener', () => {
    const openImage = vi.fn(async () => {})
    renderEditor(openImage)

    const event = new MouseEvent('click')
    act(() => captured.props?.onLinkClick?.({ href: 'assets/cat.png', event }))

    expect(openImage).toHaveBeenCalledWith('assets/cat.png')
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('routes a reflect:// link through the in-app deep-link intake, not the URL opener', () => {
    renderEditor()

    const event = new MouseEvent('click')
    act(() => captured.props?.onLinkClick?.({ href: 'reflect://note/abc123', event }))

    expect(dispatchDeepLink).toHaveBeenCalledWith('reflect://note/abc123')
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('⌘-click sends a reflect:// link to a new window instead of dispatching', async () => {
    openDeepLinkInNewWindow.mockResolvedValue(true)
    renderEditor()

    const event = new MouseEvent('click', { metaKey: true })
    act(() => captured.props?.onLinkClick?.({ href: 'reflect://note/abc123', event }))

    await waitFor(() =>
      expect(openDeepLinkInNewWindow).toHaveBeenCalledWith('reflect://note/abc123'),
    )
    expect(dispatchDeepLink).not.toHaveBeenCalled()
  })

  it('a declined ⌘-click open degrades to the normal deep-link dispatch', async () => {
    openDeepLinkInNewWindow.mockResolvedValue(false)
    renderEditor()

    const event = new MouseEvent('click', { metaKey: true })
    act(() => captured.props?.onLinkClick?.({ href: 'reflect://append?text=hi', event }))

    await waitFor(() => expect(dispatchDeepLink).toHaveBeenCalledWith('reflect://append?text=hi'))
  })
})

describe('NoteEditor file pills', () => {
  it('passes the file-link resolver through unchanged (meowdown reads it once)', () => {
    const resolveFileLink = vi.fn(() => true)
    render(<NoteEditor initialContent="" resolveFileLink={resolveFileLink} />)
    expect(captured.props?.resolveFileLink).toBe(resolveFileLink)
  })

  it('omits the resolver when the host claims no file links', () => {
    render(<NoteEditor initialContent="" />)
    expect('resolveFileLink' in (captured.props ?? {})).toBe(false)
  })

  it('opens a clicked assets/ pill through the graph asset opener, not the URL opener', () => {
    const openAsset = vi.fn(async () => {})
    renderEditor(openAsset)

    const event = new MouseEvent('click')
    act(() => captured.props?.onFileClick?.({ href: 'assets/cat.png', name: 'cat.png', event }))

    expect(openAsset).toHaveBeenCalledWith('assets/cat.png')
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('forwards pill size lookups to resolveFileInfo', async () => {
    const resolveFileInfo = vi.fn(async () => ({ size: 42 }))
    render(<NoteEditor initialContent="" resolveFileInfo={resolveFileInfo} />)

    await expect(captured.props?.resolveFileInfo?.('assets/q3.pdf')).resolves.toEqual({
      size: 42,
    })
    expect(resolveFileInfo).toHaveBeenCalledExactlyOnceWith('assets/q3.pdf')
  })
})

describe('NoteEditor file paste', () => {
  it('forwards meowdown paste to saveFile and returns its destination', async () => {
    const saveFile = vi.fn(async () => 'assets/report.pdf')
    render(<NoteEditor initialContent="" saveFile={saveFile} />)

    const pasted = new File([new Uint8Array(4)], 'q3.pdf', { type: 'application/pdf' })
    await expect(captured.props?.onFilePaste?.(pasted)).resolves.toBe('assets/report.pdf')
    expect(saveFile).toHaveBeenCalledExactlyOnceWith(pasted)
  })

  it('declines the paste (undefined) when saveFile returns null', async () => {
    render(<NoteEditor initialContent="" saveFile={async () => null} />)
    const pasted = new File([], 'q3.pdf', { type: 'application/pdf' })
    await expect(captured.props?.onFilePaste?.(pasted)).resolves.toBeUndefined()
  })
})
