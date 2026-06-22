import { type ReactNode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
): ReturnType<typeof render> {
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
        resolveImageOpenPath={(src) => (src === 'assets/cat.png' ? 'assets/cat.png' : null)}
        openImage={secondOpenImage}
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
        resolveImageOpenPath={(src) => (src === 'assets/cat.png' ? 'assets/cat.png' : null)}
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
})
