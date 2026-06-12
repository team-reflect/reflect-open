import {
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { defineDocChangeHandler, union, type Editor } from '@prosekit/core'
import { ProseKit, useExtension } from '@prosekit/react'
import { cn } from '@/lib/utils'
import { defineImages, type ImageOptions } from './images'
import { defineReflectKeymap } from './keymap'
import {
  createMeowdownEditor,
  defineMarkMode,
  parseMarkdown,
  serializeMarkdown,
  type MarkMode,
  type MeowdownEditorHandle,
} from './meowdown'
import { defineTitlePlaceholder } from './title-placeholder'
import { defineWikiLinks } from './wiki-links'

/**
 * Reflect's editor (Plan 05): meowdown's engine (via the `./meowdown` bridge)
 * composed with our own extensions (wiki-link navigation, images, the central
 * keymap). Mirrors `@meowdown/react`'s `<Editor>` — which accepts no extra
 * extensions — so we own the composition point.
 *
 * The component is **uncontrolled**: `initialContent` is read once. Showing a
 * different note or reloading after an external change goes through the
 * imperative {@link NoteEditorHandle} (or a remount via `key`), never a prop
 * change — the Plan 05 contract.
 */

/**
 * Imperative surface for note switching, reload, and save flushes. Extends
 * meowdown's own handle contract (`getMarkdown`) with what Reflect's document
 * pipeline needs on top.
 */
export interface NoteEditorHandle extends MeowdownEditorHandle {
  /** Replace the document (note switch / external reload). */
  setMarkdown(markdown: string): void
  focus(): void
}

interface NoteEditorProps {
  /** Initial markdown, read only on first render (uncontrolled). */
  initialContent: string
  /** Called with the current markdown whenever the document changes. */
  onChange?: (markdown: string) => void
  /** How markdown syntax characters are shown; `focus` reveals them near the caret. */
  markMode?: MarkMode
  /**
   * Whether the browser underlines misspelled words (default on). ProseKit has
   * no spellcheck option of its own, but none is needed: the mount div *is*
   * the contenteditable, so the native DOM attribute is the editor setting.
   */
  spellCheck?: boolean
  /** Image rendering + paste/drop persistence (Plan 05b). */
  images?: ImageOptions
  /** Click on a `[[wiki link]]` (Plan 06 navigation). */
  onWikiLinkClick?: (target: string) => void
  /**
   * Ghost text over a leading empty H1 (the new-note flow's "Untitled");
   * omitted for documents without title semantics (the daily stream).
   */
  titlePlaceholder?: string
  /**
   * Extra classes for the editable root. The mount div *is* the ProseMirror
   * contenteditable, so e.g. a `min-h-*` here makes the whole reserved area
   * click-to-focus (the daily stream uses this for per-day sizing).
   */
  className?: string
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
  return createMeowdownEditor(
    initialContent,
    union(defineWikiLinks({ onNavigate }), defineImages(images), defineReflectKeymap()),
  )
}

export function NoteEditor({
  initialContent,
  onChange,
  markMode = 'focus',
  spellCheck = true,
  images,
  onWikiLinkClick,
  titlePlaceholder,
  className,
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
      () => (titlePlaceholder !== undefined ? defineTitlePlaceholder(titlePlaceholder) : null),
      [titlePlaceholder],
    ),
    { editor },
  )

  useExtension(
    useMemo(
      () =>
        onChange
          ? defineDocChangeHandler(() => {
              onChange(serializeMarkdown(editor.state.doc))
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
        editor.setContent(parseMarkdown(editor, markdown))
      },
      getMarkdown: () => serializeMarkdown(editor.state.doc),
      focus: () => editor.focus(),
    }),
    [editor],
  )

  return (
    <ProseKit editor={editor}>
      {/* The `.meowdown` wrapper opts into the meowdown stylesheet's editor
          scope (selection styling); the mount div is the ProseMirror root. */}
      <div className="meowdown">
        <div
          ref={editor.mount}
          spellCheck={spellCheck}
          className={cn('reflect-editor', className)}
        />
      </div>
      {children}
    </ProseKit>
  )
}
