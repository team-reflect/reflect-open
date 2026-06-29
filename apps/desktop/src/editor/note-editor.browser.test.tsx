import { type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { act } from '@/test-utils/act'
import { openUrl } from '@tauri-apps/plugin-opener'
import { NoteEditor } from './note-editor'

/** Props the mocked `<MeowdownEditor>` captures so the test can drive its callbacks. */
interface CapturedEditorProps {
  mode?: 'hide' | 'focus' | 'show' | 'source'
  editorClassName?: string
  children?: ReactNode
  resolveImageUrl?: (src: string) => string | undefined
  onImageClick?: (payload: { src: string; alt: string; event: MouseEvent }) => void
  onLinkClick?: (payload: { href: string; event: MouseEvent }) => void
  onTagClick?: (payload: { tag: string; event: MouseEvent }) => void
}

const captured = vi.hoisted(() => ({ props: null as CapturedEditorProps | null }))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => {}),
}))

// Stub the editor: capture its props and render the image-preview DOM shape
// meowdown produces, so the source element lookup in `onImageClick` resolves.
vi.mock('@meowdown/react', () => ({
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
  openImage: (path: string) => Promise<void> | void = vi.fn(async () => {}),
) {
  return render(
    <NoteEditor
      initialContent={'A photo\n\n![Cat](assets/cat.png)'}
      resolveImageUrl={(src) => (src === 'assets/cat.png' ? 'asset://cat.png' : null)}
      resolveImageOpenPath={(src) =>
        src === 'assets/cat.png' ? 'assets/cat.png' : null
      }
      openImage={openImage}
    />,
  )
}

/** A click payload as meowdown's `onImageClick` would deliver it. */
function imageClick(src: string, alt: string): { src: string; alt: string; event: MouseEvent } {
  const image = page.getByTestId('inline-image').element()
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
  vi.clearAllMocks()
})

describe('NoteEditor markdown syntax mode', () => {
  it('passes hide to meowdown by default', async () => {
    await renderEditor()
    expect(captured.props?.mode).toBe('hide')
  })

  it('passes an explicit markdown syntax mode to meowdown', async () => {
    await render(<NoteEditor initialContent="" markMode="show" />)
    expect(captured.props?.mode).toBe('show')
  })
})

describe('NoteEditor tag click', () => {
  it('forwards a clicked tag name, without the leading #', async () => {
    const onTagClick = vi.fn()
    await render(<NoteEditor initialContent="" onTagClick={onTagClick} />)
    expect(captured.props?.onTagClick).toBeTypeOf('function')

    const event = new MouseEvent('click', { bubbles: true })
    act(() => captured.props?.onTagClick?.({ tag: 'book', event }))
    expect(onTagClick).toHaveBeenCalledWith('book')
  })
})

describe('NoteEditor image lightbox', () => {
  it('opens a lightbox from an inline image and closes on Escape', async () => {
    await renderEditor()
    expect(captured.props?.onImageClick).toBeTypeOf('function')

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    const dialog = page.getByRole('dialog', { name: 'Image preview' })
    await expect.element(dialog).toBeInTheDocument()
    const preview = dialog.element().querySelector('img')
    expect(preview).toBeInstanceOf(HTMLImageElement)
    expect(preview?.src).toBe('asset://cat.png')

    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('uses the native View Transition API when available', async () => {
    const startViewTransition = installViewTransitionMock()
    await renderEditor()

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    expect(startViewTransition).toHaveBeenCalledTimes(1)
    await expect.element(page.getByRole('dialog', { name: 'Image preview' })).toBeInTheDocument()
  })

  it('opens a local image through the graph asset opener', async () => {
    const openImage = vi.fn(async () => {})
    await renderEditor(openImage)

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    await userEvent.click(page.getByRole('button', { name: 'Open' }))
    expect(openImage).toHaveBeenCalledWith('assets/cat.png')
  })

  it('uses the opener captured when the lightbox opens', async () => {
    const firstOpenImage = vi.fn(async () => {})
    const secondOpenImage = vi.fn(async () => {})
    const view = await renderEditor(firstOpenImage)

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))
    await expect.element(page.getByRole('dialog', { name: 'Image preview' })).toBeInTheDocument()

    await view.rerender(
      <NoteEditor
        initialContent={'A photo\n\n![Cat](assets/cat.png)'}
        resolveImageUrl={(src) => (src === 'assets/cat.png' ? 'asset://cat.png' : null)}
        resolveImageOpenPath={(src) => (src === 'assets/cat.png' ? 'assets/cat.png' : null)}
        openImage={secondOpenImage}
      />,
    )

    await userEvent.click(page.getByRole('button', { name: 'Open' }))
    expect(firstOpenImage).toHaveBeenCalledWith('assets/cat.png')
    expect(secondOpenImage).not.toHaveBeenCalled()
  })

  it('hides the Open button when no opener is provided', async () => {
    await render(
      <NoteEditor
        initialContent={'A photo\n\n![Cat](assets/cat.png)'}
        resolveImageUrl={(src) => (src === 'assets/cat.png' ? 'asset://cat.png' : null)}
        resolveImageOpenPath={(src) => (src === 'assets/cat.png' ? 'assets/cat.png' : null)}
      />,
    )

    act(() => captured.props?.onImageClick?.(imageClick('assets/cat.png', 'Cat')))

    await expect.element(page.getByRole('dialog', { name: 'Image preview' })).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Open' })).not.toBeInTheDocument()
  })

  it('does not open a lightbox when the source cannot be resolved', async () => {
    await renderEditor()

    act(() => captured.props?.onImageClick?.(imageClick('https://blocked.example/x.png', 'X')))

    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('NoteEditor link opening', () => {
  it('opens external links via onLinkClick', async () => {
    await renderEditor()
    expect(captured.props?.onLinkClick).toBeTypeOf('function')

    const event = new MouseEvent('click')
    act(() => captured.props?.onLinkClick?.({ href: 'https://example.com', event }))

    expect(openUrl).toHaveBeenCalledWith('https://example.com')
  })
})
