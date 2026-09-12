import { useId, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { Textarea } from '@/components/ui/textarea'

interface TextSettingDrawerProps {
  title: string
  description: string
  /** Accessible name of the textarea. */
  ariaLabel: string
  placeholder: string
  /** Characters kept on save; longer drafts show a warning and are truncated. */
  maxLength: number
  rows: number
  /** Canonicalize a draft before it is saved or compared with the default. */
  normalize: (value: string) => string
  value: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (value: string) => void
}

/** The mobile editor for one free-text setting: Save persists, Clear empties. */
export function TextSettingDrawer({
  title,
  open,
  onOpenChange,
  ...sheet
}: TextSettingDrawerProps): ReactElement {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label={title}>
        {open ? (
          <TextSettingSheet title={title} onClose={() => onOpenChange(false)} {...sheet} />
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

function TextSettingSheet({
  title,
  description,
  ariaLabel,
  placeholder,
  maxLength,
  rows,
  normalize,
  value,
  onSave,
  onClose,
}: Omit<TextSettingDrawerProps, 'open' | 'onOpenChange'> & { onClose: () => void }): ReactElement {
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)
  const warningId = useId()
  const currentDraft = dirty ? draft : value
  const overBy = currentDraft.trim().length - maxLength

  return (
    <>
      <DrawerTitle>{title}</DrawerTitle>
      <DrawerBody>
        <p className="text-sm text-text-muted">{description}</p>
        <Textarea
          aria-label={ariaLabel}
          aria-invalid={overBy > 0 || undefined}
          aria-describedby={overBy > 0 ? warningId : undefined}
          value={currentDraft}
          onChange={(event) => {
            setDirty(true)
            setDraft(event.target.value)
          }}
          rows={rows}
          autoFocus
          placeholder={placeholder}
          className="min-h-36 resize-y text-sm"
        />
        {overBy > 0 ? (
          <p id={warningId} role="alert" className="text-xs text-destructive">
            {overBy.toLocaleString()} characters over the {maxLength.toLocaleString()}-character
            limit. The extra text is dropped when saved.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={normalize(currentDraft) === ''}
            onClick={() => {
              onSave('')
              onClose()
            }}
          >
            Clear
          </Button>
          <Button
            type="button"
            onClick={() => {
              onSave(normalize(currentDraft))
              onClose()
            }}
          >
            Save
          </Button>
        </div>
      </DrawerBody>
    </>
  )
}
