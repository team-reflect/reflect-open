import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoteEditor } from './note-editor'

const VIEW_TRANSITION_NAME = 'reflect-image-lightbox'

type MockClickHandler = (view: unknown, pos: number, event: MouseEvent) => boolean | void

interface MockClickExtension {
  clickHandler: MockClickHandler
}

const proseKitMock = vi.hoisted(() => ({
  clickHandler: null as MockClickHandler | null,
}))

const openerMock = vi.hoisted(() => ({
  openPath: vi.fn(async () => {}),
}))

interface MockMeowdownEditorProps {
  children?: ReactNode
  editorClassName?: string
  resolveImageUrl?: (src: string) => string | undefined
}

vi.mock('@prosekit/core', () => ({
  defineClickHandler: vi.fn(
    (clickHandler: MockClickHandler): MockClickExtension => ({ clickHandler }),
  ),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: openerMock.openPath,
}))

vi.mock('@meowdown/react', () => ({
  useExtension: vi.fn((extension: MockClickExtension | null) => {
    proseKitMock.clickHandler = extension?.clickHandler ?? null
  }),
  MeowdownEditor: ({ children, editorClassName, resolveImageUrl }: MockMeowdownEditorProps) => (
    <div className="meowdown">
      <div className={editorClassName}>
        <p>Editor text</p>
        <div className="md-image">
          <img src={resolveImageUrl?.('assets/cat.png')} alt="Cat" />
        </div>
        {children}
      </div>
    </div>
  ),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  proseKitMock.clickHandler = null
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

function renderEditor(): ReturnType<typeof render> {
  return render(
    <NoteEditor
      initialContent="A photo\n\n![Cat](assets/cat.png)"
      resolveImageUrl={(src) => (src === 'assets/cat.png' ? 'asset://cat.png' : null)}
      resolveImageOpenPath={(src) =>
        src === 'assets/cat.png' ? '/Users/alex/notes/assets/cat.png' : null
      }
    />,
  )
}

function findInlineImage(container: HTMLElement): HTMLImageElement {
  const image = container.querySelector('.md-image img')
  if (!(image instanceof HTMLImageElement)) {
    throw new Error('Expected meowdown image widget to render')
  }
  return image
}

function installViewTransitionMock(): ReturnType<typeof vi.fn> {
  function expectSingleNamedElement(): void {
    const namedElements = Array.from(document.querySelectorAll<HTMLElement>('[style]'))
      .filter((element) => element.style.viewTransitionName === VIEW_TRANSITION_NAME)
    expect(namedElements.length).toBeLessThanOrEqual(1)
  }

  const startViewTransition = vi.fn((callback?: ViewTransitionUpdateCallback): ViewTransition => {
    expectSingleNamedElement()
    const update = callback?.()
    expectSingleNamedElement()
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

function clickElement(element: Element): void {
  act(() => {
    const event = new MouseEvent('click', { bubbles: true, button: 0, cancelable: true })
    element.dispatchEvent(event)
    proseKitMock.clickHandler?.({}, 0, event)
  })
}

describe('NoteEditor image lightbox', () => {
  it('opens an image lightbox from an inline image and closes on Escape', async () => {
    const { container } = renderEditor()
    const image = await waitFor(() => findInlineImage(container))

    clickElement(image)

    const dialog = await screen.findByRole('dialog', { name: 'Image preview' })
    const preview = dialog.querySelector('img')
    expect(preview).toBeInstanceOf(HTMLImageElement)
    expect((preview as HTMLImageElement).src).toBe('asset://cat.png')

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('uses the native View Transition API when available', async () => {
    const startViewTransition = installViewTransitionMock()
    const { container } = renderEditor()
    const image = await waitFor(() => findInlineImage(container))

    clickElement(image)

    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('dialog', { name: 'Image preview' })).toBeTruthy()
  })

  it('closes the lightbox from the expanded image click', async () => {
    const startViewTransition = installViewTransitionMock()
    const { container } = renderEditor()
    const image = await waitFor(() => findInlineImage(container))

    clickElement(image)

    const dialog = await screen.findByRole('dialog', { name: 'Image preview' })
    const preview = dialog.querySelector('img')
    if (!(preview instanceof HTMLImageElement)) {
      throw new Error('Expected lightbox image to render')
    }

    await userEvent.click(preview)

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(startViewTransition).toHaveBeenCalledTimes(2)
  })

  it('opens the lightbox image in Preview', async () => {
    const { container } = renderEditor()
    const image = await waitFor(() => findInlineImage(container))

    clickElement(image)

    await userEvent.click(await screen.findByRole('button', { name: 'Open' }))

    expect(openerMock.openPath).toHaveBeenCalledWith(
      '/Users/alex/notes/assets/cat.png',
      'Preview',
    )
  })

  it('does not open the lightbox for non-image editor clicks', async () => {
    const { container } = renderEditor()
    const editor = container.querySelector('.reflect-editor')
    if (!(editor instanceof HTMLElement)) {
      throw new Error('Expected editor root to render')
    }

    fireEvent.click(editor)

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
