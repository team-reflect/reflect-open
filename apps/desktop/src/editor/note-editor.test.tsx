import { createRef } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { dispatchDeepLink } from '@/lib/deep-links/intake'
import { setPlatformSurface } from '@/lib/platform-surface'
import { expectLocatorToHaveCount } from '@/test-utils/expect'
import { pasteFiles } from '@/test-utils/file-events'
import '@/test-utils/locator'
import { NoteEditor, type NoteEditorHandle } from './note-editor'

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

const pmRoot = page.locate('.ProseMirror')

const IMAGE_NOTE = 'A photo\n\n![Cat](assets/cat.png)'

function renderEditor(
  openAsset: (path: string) => Promise<void> | void = vi.fn(async () => {}),
): ReturnType<typeof render> {
  return render(
    <NoteEditor
      initialContent={IMAGE_NOTE}
      resolveImageUrl={(src) => (src === 'assets/cat.png' ? 'asset://cat.png' : null)}
      resolveAssetOpenPath={(src) => (src === 'assets/cat.png' ? 'assets/cat.png' : null)}
      openAsset={openAsset}
    />,
  )
}

function firePointer(element: Element, type: string, init: PointerEventInit): void {
  element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }))
}

afterEach(() => {
  setPlatformSurface({ touchEditor: false, mobileApp: false })
  vi.clearAllMocks()
})

describe('NoteEditor markdown syntax mode', () => {
  it('hides markdown syntax by default', async () => {
    await render(<NoteEditor initialContent="Hello" />)
    await expect.element(pmRoot).toHaveAttribute('data-mark-mode', 'hide')
  })

  it('applies an explicit markdown syntax mode', async () => {
    await render(<NoteEditor initialContent="Hello" markMode="show" />)
    await expect.element(pmRoot).toHaveAttribute('data-mark-mode', 'show')
  })
})

describe('NoteEditor wiki-link hover card', () => {
  it('does not mount the optional card without a host renderer', async () => {
    await render(<NoteEditor initialContent="see [[Note]] here" />)
    await pmRoot.getByTestId('wikilink').hover()
    await expect.element(pmRoot.getByTestId('wikilink')).toBeVisible()
    await expectLocatorToHaveCount(page.getByTestId('wikilink-hover-card'), 0)
  })

  it('shows the host-rendered card body when a wiki link is hovered', async () => {
    await render(
      <NoteEditor
        initialContent="see [[Note]] here"
        renderWikilinkHoverCard={() => <div data-testid="reflect-hover-body">Preview</div>}
      />,
    )
    await pmRoot.getByTestId('wikilink').hover()
    await expect.element(page.getByTestId('reflect-hover-body'), { timeout: 5_000 }).toBeVisible()
  })
})

describe('NoteEditor time format', () => {
  it('inserts a 12-hour time through /now by default', async () => {
    const handleRef = createRef<NoteEditorHandle>()
    await render(<NoteEditor initialContent="" handleRef={handleRef} />)

    await pmRoot.click()
    await userEvent.keyboard('/now')
    await expect.element(page.getByRole('option', { name: /now/i })).toBeVisible()
    await userEvent.keyboard('{Enter}')

    await vi.waitFor(() => {
      expect(handleRef.current?.getMarkdown()).toMatch(/^\d{1,2}:\d{2}(am|pm)\n$/)
    })
  })

  it("maps the 24h setting to meowdown's 24-hour clock", async () => {
    const handleRef = createRef<NoteEditorHandle>()
    await render(<NoteEditor initialContent="" timeFormat="24h" handleRef={handleRef} />)

    await pmRoot.click()
    await userEvent.keyboard('/now')
    await expect.element(page.getByRole('option', { name: /now/i })).toBeVisible()
    await userEvent.keyboard('{Enter}')

    await vi.waitFor(() => {
      expect(handleRef.current?.getMarkdown()).toMatch(/^\d{2}:\d{2}\n$/)
    })
  })
})

describe('NoteEditor smooth caret animation', () => {
  it('enables the caret glide by default', async () => {
    await render(<NoteEditor initialContent="Hello" />)
    await pmRoot.click()
    const caret = page.getByTestId('virtual-caret')
    await expect.element(caret).toBeVisible()
    expect(getComputedStyle(caret.element()).getPropertyValue('--meowdown-caret-glide')).toBe(
      '80ms',
    )
  })

  it('disables the caret glide when smooth caret animation is off', async () => {
    await render(<NoteEditor initialContent="Hello" smoothCaretAnimation={false} />)
    await pmRoot.click()
    const caret = page.getByTestId('virtual-caret')
    await expect.element(caret).toBeVisible()
    expect(getComputedStyle(caret.element()).getPropertyValue('--meowdown-caret-glide')).toBe(
      '0ms',
    )
  })
})

describe('NoteEditor touch-surface input hygiene', () => {
  it('passes the spellcheck setting through on desktop', async () => {
    await render(<NoteEditor initialContent="Hello" spellCheck={true} />)
    await expect.element(pmRoot).toBeVisible()
    const editable = pmRoot.element()
    expect(editable).toBeInstanceOf(HTMLElement)
    await expect.poll(() => (editable as HTMLElement).spellcheck).toBe(true)
  })

  it('pins spellcheck off on the touch surface (iOS smart-punctuation gate)', async () => {
    setPlatformSurface({ touchEditor: true })
    await render(<NoteEditor initialContent="Hello" spellCheck={true} />)
    await expect.element(pmRoot).toBeVisible()
    const editable = pmRoot.element()
    expect(editable).toBeInstanceOf(HTMLElement)

    // meowdown's spell-check extension applies its value on the first input,
    // not on mount, so type one character before reading the pinned state.
    await pmRoot.click()
    await userEvent.keyboard('x')
    await expect.poll(() => (editable as HTMLElement).spellcheck).toBe(false)
  })

  it('shows the block handle on hover on desktop', async () => {
    await render(<NoteEditor initialContent="Hello" blockHandle={true} />)
    await pmRoot.getByText('Hello').hover()
    await expect.element(page.getByTestId('block-handle')).toBeVisible()
  })

  it('pins the block handle off on the touch surface', async () => {
    setPlatformSurface({ touchEditor: true })
    await render(<NoteEditor initialContent="Hello" blockHandle={true} />)
    await pmRoot.getByText('Hello').hover()
    await expect.element(pmRoot.getByText('Hello')).toBeVisible()
    await expectLocatorToHaveCount(page.getByTestId('block-handle'), 0)
  })

  it('sets explicit input traits on the contenteditable on the touch surface', async () => {
    setPlatformSurface({ touchEditor: true })
    await render(<NoteEditor initialContent="Hello" />)
    await expect.element(pmRoot).toHaveAttribute('autocapitalize', 'sentences')
    await expect.element(pmRoot).toHaveAttribute('autocorrect', 'on')
  })

  it('leaves the contenteditable untouched on desktop', async () => {
    await render(<NoteEditor initialContent="Hello" />)
    await expect.element(pmRoot).toBeVisible()
    await expect.element(pmRoot).not.toHaveAttribute('autocapitalize')
    await expect.element(pmRoot).not.toHaveAttribute('autocorrect')
  })
})

describe('NoteEditor tag click', () => {
  it('forwards a clicked tag name, without the leading #', async () => {
    const onTagClick = vi.fn()
    await render(<NoteEditor initialContent="see #book here" onTagClick={onTagClick} />)

    await pmRoot.getByText('#book').click()
    await vi.waitFor(() => {
      expect(onTagClick).toHaveBeenCalledWith('book')
    })
  })
})

describe('NoteEditor image lightbox', () => {
  it('opens a lightbox from an inline image and closes on Escape', async () => {
    await renderEditor()

    await pmRoot.getByAltText('Cat').click()
    const dialog = page.getByRole('dialog', { name: 'Image preview' })
    await expect.element(dialog).toBeVisible()
    const preview = dialog.locate('img')
    expect(preview.element()).toHaveProperty('src', 'asset://cat.png')

    await userEvent.keyboard('{Escape}')
    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
  })

  it('opens a local image through the graph asset opener', async () => {
    const openImage = vi.fn(async () => {})
    await renderEditor(openImage)

    await pmRoot.getByAltText('Cat').click()
    await page.getByRole('button', { name: 'Open' }).click()
    await vi.waitFor(() => {
      expect(openImage).toHaveBeenCalledWith('assets/cat.png')
    })
  })

  it('keeps the image opener inside iOS safe-area bounds', async () => {
    await renderEditor()

    await pmRoot.getByAltText('Cat').click()
    const opener = page.getByRole('button', { name: 'Open' })
    await expect.element(opener).toBeVisible()
    expect(opener.element().parentElement?.className).toContain(
      'top-[max(env(safe-area-inset-top),1rem)]',
    )
    expect(opener.element().parentElement?.className).toContain(
      'right-[max(env(safe-area-inset-right),1rem)]',
    )
  })

  it('shows mobile close chrome inside iOS safe-area bounds', async () => {
    setPlatformSurface({ mobileApp: true })
    await renderEditor()

    await pmRoot.getByAltText('Cat').click()
    const close = page.getByRole('button', { name: 'Close', exact: true })
    await expect.element(close).toBeVisible()
    expect(close.element().parentElement?.className).toContain(
      'top-[max(env(safe-area-inset-top),1rem)]',
    )
    expect(close.element().parentElement?.className).toContain(
      'left-[max(env(safe-area-inset-left),1rem)]',
    )
    await expect.element(page.getByRole('dialog', { name: 'Image preview' }).locate('.bg-black')).toBeInTheDocument()
  })

  it('dismisses the mobile image lightbox with a downward drag', async () => {
    setPlatformSurface({ mobileApp: true })
    await renderEditor()

    await pmRoot.getByAltText('Cat').click()
    const preview = page.getByRole('button', { name: 'Close image preview' })
    await expect.element(preview).toBeVisible()
    const image = preview.locate('img').element()
    expect(image).toBeInstanceOf(HTMLImageElement)

    firePointer(preview.element(), 'pointerdown', {
      pointerId: 1,
      isPrimary: true,
      pointerType: 'touch',
      clientX: 180,
      clientY: 120,
    })
    firePointer(preview.element(), 'pointermove', { pointerId: 1, clientX: 182, clientY: 190 })
    firePointer(preview.element(), 'pointermove', { pointerId: 1, clientX: 183, clientY: 260 })
    await vi.waitFor(() => {
      expect(preview.locate('img').element()).toHaveProperty(
        'style.transform',
        expect.stringContaining(', 70px,'),
      )
    })

    firePointer(preview.element(), 'pointermove', { pointerId: 1, clientX: 184, clientY: 520 })
    firePointer(preview.element(), 'pointerup', { pointerId: 1, clientX: 184, clientY: 520 })

    await expectLocatorToHaveCount(page.getByRole('dialog'), 0, { timeout: 5_000 })
  })

  it('uses the opener captured when the lightbox opens', async () => {
    const firstOpenImage = vi.fn(async () => {})
    const secondOpenImage = vi.fn(async () => {})
    const screen = await renderEditor(firstOpenImage)

    await pmRoot.getByAltText('Cat').click()
    await expect.element(page.getByRole('dialog', { name: 'Image preview' })).toBeVisible()

    await screen.rerender(
      <NoteEditor
        initialContent={IMAGE_NOTE}
        resolveImageUrl={(src) => (src === 'assets/cat.png' ? 'asset://cat.png' : null)}
        resolveAssetOpenPath={(src) => (src === 'assets/cat.png' ? 'assets/cat.png' : null)}
        openAsset={secondOpenImage}
      />,
    )

    await page.getByRole('button', { name: 'Open' }).click()
    await vi.waitFor(() => {
      expect(firstOpenImage).toHaveBeenCalledWith('assets/cat.png')
    })
    expect(secondOpenImage).not.toHaveBeenCalled()
  })

  it('hides the Open button when no opener is provided', async () => {
    await render(
      <NoteEditor
        initialContent={IMAGE_NOTE}
        resolveImageUrl={(src) => (src === 'assets/cat.png' ? 'asset://cat.png' : null)}
        resolveAssetOpenPath={(src) => (src === 'assets/cat.png' ? 'assets/cat.png' : null)}
      />,
    )

    await pmRoot.getByAltText('Cat').click()
    await expect.element(page.getByRole('dialog', { name: 'Image preview' })).toBeVisible()
    await expectLocatorToHaveCount(page.getByRole('button', { name: 'Open' }), 0)
  })

  it('skips rendering an image whose source cannot be resolved', async () => {
    await render(
      <NoteEditor
        initialContent={'![Cat](assets/cat.png)\n\n![X](https://blocked.example/x.png)'}
        resolveImageUrl={(src) => (src === 'assets/cat.png' ? 'asset://cat.png' : null)}
      />,
    )

    await expect.element(pmRoot.getByAltText('Cat')).toBeInTheDocument()
    await expectLocatorToHaveCount(pmRoot.locate('img'), 1)
  })
})

describe('NoteEditor link opening', () => {
  it('opens external links through the OS opener', async () => {
    await render(<NoteEditor initialContent="see [Docs](https://example.com) here" />)

    await pmRoot.getByRole('link').click()
    await vi.waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('https://example.com')
    })
  })

  it('opens a custom app scheme link via the URL opener', async () => {
    await render(
      <NoteEditor initialContent="[note](x-devonthink-item://40C88434-68B6-4DCB) here" />,
    )

    await pmRoot.getByRole('link').click()
    await vi.waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('x-devonthink-item://40C88434-68B6-4DCB')
    })
  })

  it('drops an unsafe scheme link without opening anything', async () => {
    await render(<NoteEditor initialContent="[secret](file:///etc/passwd) here" />)

    await pmRoot.getByRole('link').click()
    await expect.element(pmRoot.getByRole('link')).toBeVisible()
    expect(openUrl).not.toHaveBeenCalled()
    expect(dispatchDeepLink).not.toHaveBeenCalled()
  })

  it('opens an assets/ link through the graph asset opener, not the URL opener', async () => {
    const openAsset = vi.fn(async () => {})
    await render(
      <NoteEditor
        initialContent="[cat](assets/cat.png) here"
        resolveAssetOpenPath={(src) => (src === 'assets/cat.png' ? 'assets/cat.png' : null)}
        openAsset={openAsset}
      />,
    )

    await pmRoot.getByRole('link').click()
    await vi.waitFor(() => {
      expect(openAsset).toHaveBeenCalledWith('assets/cat.png')
    })
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('routes a reflect:// link through the in-app deep-link intake, not the URL opener', async () => {
    await render(<NoteEditor initialContent="[note](reflect://note/abc123) here" />)

    await pmRoot.getByRole('link').click()
    await vi.waitFor(() => {
      expect(dispatchDeepLink).toHaveBeenCalledWith('reflect://note/abc123')
    })
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('⌘-click sends a reflect:// link to a new window instead of dispatching', async () => {
    openDeepLinkInNewWindow.mockResolvedValue(true)
    await render(<NoteEditor initialContent="[note](reflect://note/abc123) here" />)

    await pmRoot.getByRole('link').click({ modifiers: ['Meta'] })
    await vi.waitFor(() => {
      expect(openDeepLinkInNewWindow).toHaveBeenCalledWith('reflect://note/abc123')
    })
    expect(dispatchDeepLink).not.toHaveBeenCalled()
  })

  it('a declined ⌘-click open degrades to the normal deep-link dispatch', async () => {
    openDeepLinkInNewWindow.mockResolvedValue(false)
    await render(<NoteEditor initialContent="[append](reflect://append?text=hi) here" />)

    await pmRoot.getByRole('link').click({ modifiers: ['Meta'] })
    await vi.waitFor(() => {
      expect(dispatchDeepLink).toHaveBeenCalledWith('reflect://append?text=hi')
    })
  })
})

describe('NoteEditor file pills', () => {
  const claimAssets = ({ href }: { href: string }) => href.startsWith('assets/')

  it('renders a claimed link as a pill with its resolved size', async () => {
    await render(
      <NoteEditor
        initialContent="[report.pdf](assets/report.pdf)"
        resolveFileLink={claimAssets}
        resolveFileInfo={() => Promise.resolve({ size: 1_400_000 })}
      />,
    )

    const pill = pmRoot.getByTestId('file-pill')
    await expect.element(pill).toHaveTextContent('report.pdf')
    await expect.element(pmRoot.getByTestId('file-pill-size')).toHaveTextContent('1.4 MB')
  })

  it('leaves links as links when the host claims no file links', async () => {
    await render(<NoteEditor initialContent="[report.pdf](assets/report.pdf)" />)

    await expect.element(pmRoot.getByRole('link')).toBeInTheDocument()
    await expectLocatorToHaveCount(pmRoot.getByTestId('file-pill'), 0)
  })

  it('opens a clicked assets/ pill through the graph asset opener, not the URL opener', async () => {
    const openAsset = vi.fn(async () => {})
    await render(
      <NoteEditor
        initialContent="[cat.png](assets/cat.png)"
        resolveFileLink={claimAssets}
        resolveAssetOpenPath={(src) => (src === 'assets/cat.png' ? 'assets/cat.png' : null)}
        openAsset={openAsset}
      />,
    )

    await pmRoot.getByTestId('file-pill').click()
    await vi.waitFor(() => {
      expect(openAsset).toHaveBeenCalledWith('assets/cat.png')
    })
    expect(openUrl).not.toHaveBeenCalled()
  })
})

describe('NoteEditor file paste', () => {
  it('persists a pasted file through saveFile and inserts its destination', async () => {
    const handleRef = createRef<NoteEditorHandle>()
    const saveFile = vi.fn(async () => 'assets/report.pdf')
    await render(
      <NoteEditor
        initialContent=""
        handleRef={handleRef}
        saveFile={saveFile}
        resolveFileLink={({ href }) => href.startsWith('assets/')}
      />,
    )
    await expect.element(pmRoot).toBeInTheDocument()

    const pasted = new File([new Uint8Array(4)], 'q3.pdf', { type: 'application/pdf' })
    pasteFiles(pmRoot.element(), [pasted])

    await expect.element(pmRoot.getByTestId('file-pill')).toHaveTextContent('q3.pdf')
    expect(saveFile).toHaveBeenCalledExactlyOnceWith(pasted)
    expect(handleRef.current?.getMarkdown()).toBe('[q3.pdf](assets/report.pdf)\n')
  })

  it('declines the paste when saveFile returns null', async () => {
    const handleRef = createRef<NoteEditorHandle>()
    const saveFile = vi.fn(async () => null)
    await render(<NoteEditor initialContent="" handleRef={handleRef} saveFile={saveFile} />)
    await expect.element(pmRoot).toBeInTheDocument()

    pasteFiles(pmRoot.element(), [new File([], 'q3.pdf', { type: 'application/pdf' })])

    await vi.waitFor(() => {
      expect(saveFile).toHaveBeenCalled()
    })
    expect(handleRef.current?.getMarkdown()).toBe('\n')
  })
})
