import {
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import {
  defineEditorExtension,
  defineMarkMode,
  docToMarkdown,
  markdownToDoc,
  type MarkMode,
  type TypedEditor,
} from '@meowdown/core'
import { createEditor, defineDocChangeHandler, union, type Editor } from '@prosekit/core'
import { ProseKit, useExtension } from '@prosekit/react'
import '@meowdown/core/style.css'
import { defineImages, type ImageOptions } from './images'
import { defineReflectKeymap } from './keymap'
import { selectFirstHeadingText } from './title-selection'
import { defineWikiLinks } from './wiki-links'

/**
 * Reflect's editor (Plan 05): meowdown's extension set composed with our own
 * (wiki-link chips, the central keymap). Mirrors `@meowdown/react`'s `<Editor>`
 * — which accepts no extra extensions — so we own the composition point.
 *
 * The component is **uncontrolled**: `initialContent` is read once. Showing a
 * different note or reloading after an external change goes through the
 * imperative {@link NoteEditorHandle} (or a remount via `key`), never a prop
 * change — the Plan 05 contract.
 */

/** Imperative surface for note switching, reload, and save flushes. */
export interface NoteEditorHandle {
  /** Replace the document (note switch / external reload). */
  setMarkdown(markdown: string): void
  /** Serialize the current document to markdown. */
  getMarkdown(): string
  focus(): void
  /**
   * Focus with the first heading's text selected, so typing replaces it (the
   * seeded-"Untitled" new-note flow). Plain focus when there is no heading.
   */
  selectTitle(): void
}

interface NoteEditorProps {
  /** Initial markdown, read only on first render (uncontrolled). */
  initialContent: string
  /** Called with the current markdown whenever the document changes. */
  onChange?: (markdown: string) => void
  /** How markdown syntax characters are shown; `focus` reveals them near the caret. */
  markMode?: MarkMode
  /** Image rendering + paste/drop persistence (Plan 05b). */
  images?: ImageOptions
  /** Mod+click on a `[[wiki link]]` chip (Plan 06 navigation). */
  onWikiLinkClick?: (target: string) => void
  /** Imperative handle (React 19 ref-as-prop). */
  handleRef?: Ref<NoteEditorHandle>
  /**
   * Editor-attached UI rendered inside the ProseKit context (e.g. the `[[`
   * autocomplete popover) — children can call `useEditor()`.
   */
  children?: ReactNode
}

function createNoteEditor(
  initialContent: string,
  images: ImageOptions,
  onNavigate: (target: string) => void,
): Editor {
  const editor = createEditor({
    extension: union(
      defineEditorExtension(),
      defineWikiLinks({ onNavigate }),
      defineImages(images),
      defineReflectKeymap(),
    ),
  })
  if (initialContent) {
    // Our union schema is a superset of meowdown's; the converters only touch
    // the meowdown-owned types, so the TypedEditor view of it is sound.
    editor.setContent(markdownToDoc(editor as TypedEditor, initialContent))
  }
  return editor
}

export function NoteEditor({
  initialContent,
  onChange,
  markMode = 'focus',
  images,
  onWikiLinkClick,
  handleRef,
  children,
}: NoteEditorProps): ReactElement {
  // Extensions are created once (uncontrolled editor), so per-render options are
  // read through refs that track the latest props.
  const imagesRef = useRef<ImageOptions | undefined>(images)
  imagesRef.current = images
  const wikiClickRef = useRef<((target: string) => void) | undefined>(onWikiLinkClick)
  wikiClickRef.current = onWikiLinkClick
  const [editor] = useState(() =>
    createNoteEditor(
      initialContent,
      {
        resolveUrl: (src) => imagesRef.current?.resolveUrl(src) ?? null,
        saveImage: (file) => imagesRef.current?.saveImage?.(file) ?? Promise.resolve(null),
      },
      (target) => wikiClickRef.current?.(target),
    ),
  )

  useExtension(
    useMemo(() => defineMarkMode(markMode), [markMode]),
    { editor },
  )

  useExtension(
    useMemo(
      () =>
        onChange
          ? defineDocChangeHandler(() => {
              onChange(docToMarkdown(editor.state.doc))
            })
          : null,
      [onChange, editor],
    ),
    { editor },
  )

  useImperativeHandle(
    handleRef,
    () => ({
      setMarkdown: (markdown: string) => {
        editor.setContent(markdownToDoc(editor as TypedEditor, markdown))
      },
      getMarkdown: () => docToMarkdown(editor.state.doc),
      focus: () => editor.focus(),
      selectTitle: () => {
        editor.focus()
        editor.exec(selectFirstHeadingText)
      },
    }),
    [editor],
  )

  return (
    <ProseKit editor={editor}>
      <div ref={editor.mount} className="reflect-editor" />
      {children}
    </ProseKit>
  )
}
