import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SettingsField } from './field'

interface SettingsTextareaFieldProps {
  legend: string
  description: string
  /** Accessible name of the textarea. */
  ariaLabel: string
  value: string
  placeholder: string
  /** Characters kept on save; longer drafts show a warning and are truncated. */
  maxLength: number
  rows: number
  /** Canonicalize a draft before it is saved or compared with the default. */
  normalize: (value: string) => string
  /** Persist a normalized value (`''` restores the default). */
  onSave: (value: string) => void
  /** Whether a Use default button clears the value; on unless set to false. */
  resettable?: boolean
}

/**
 * A free-text setting: edits are held as a draft and saved on blur or unmount,
 * so a live-applying settings document is not rewritten on every keystroke.
 */
export function SettingsTextareaField({
  legend,
  description,
  ariaLabel,
  value,
  placeholder,
  maxLength,
  rows,
  normalize,
  onSave,
  resettable = true,
}: SettingsTextareaFieldProps): ReactElement {
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)
  const draftRef = useRef(draft)
  const dirtyRef = useRef(dirty)
  const onSaveRef = useRef(onSave)
  const normalizeRef = useRef(normalize)
  const warningId = useId()
  const currentDraft = dirty ? draft : value
  const overBy = currentDraft.trim().length - maxLength

  const saveDraft = () => {
    if (!dirtyRef.current) {
      return
    }
    const normalized = normalize(draftRef.current)
    draftRef.current = normalized
    dirtyRef.current = false
    setDraft(normalized)
    setDirty(false)
    onSave(normalized)
  }

  const resetToDefault = () => {
    draftRef.current = ''
    dirtyRef.current = false
    setDraft('')
    setDirty(false)
    onSave('')
  }

  useEffect(() => {
    onSaveRef.current = onSave
    normalizeRef.current = normalize
  }, [onSave, normalize])

  useEffect(
    () => () => {
      if (dirtyRef.current) {
        dirtyRef.current = false
        onSaveRef.current(normalizeRef.current(draftRef.current))
      }
    },
    [],
  )

  return (
    <SettingsField legend={legend} description={description}>
      <Textarea
        aria-label={ariaLabel}
        aria-invalid={overBy > 0 || undefined}
        aria-describedby={overBy > 0 ? warningId : undefined}
        value={currentDraft}
        onChange={(event) => {
          const nextDraft = event.target.value
          draftRef.current = nextDraft
          dirtyRef.current = true
          setDraft(nextDraft)
          setDirty(true)
        }}
        onBlur={saveDraft}
        rows={rows}
        placeholder={placeholder}
        className="mt-3 min-h-28 resize-y text-sm"
      />
      {overBy > 0 ? (
        <p id={warningId} role="alert" className="mt-1.5 text-xs text-destructive">
          {overBy.toLocaleString()} characters over the {maxLength.toLocaleString()}-character
          limit. The extra text is dropped when saved.
        </p>
      ) : null}
      {resettable ? (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={normalize(currentDraft) === ''}
            onClick={resetToDefault}
          >
            Use default
          </Button>
        </div>
      ) : null}
    </SettingsField>
  )
}
