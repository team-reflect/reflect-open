import { useMemo, type ReactElement } from 'react'
import { Drawer, DrawerContent, DrawerTitle } from '@/mobile/scroll-drawer.tsx'
import { groupModelOptions } from '@/lib/chat-model-groups.ts'
import { SettingsGroup, SettingsSelectRow } from '@/mobile/settings-list.tsx'
import { useChatActions, useChatModels } from '@/providers/chat-provider.tsx'
import { useNativeMenuDrawer } from '@/mobile/native-chrome/native-menu.ts'

interface ChatModelDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The mobile model picker: desktop's grouped `Select` as a bottom sheet —
 * one inset group per configured provider, checkmark rows per model
 * (the iOS single-choice idiom). Picking persists through the session's
 * `selectModel` (the same `chatModelSelection` settings key) and closes.
 */
export function ChatModelDrawer({ open, onOpenChange }: ChatModelDrawerProps): ReactElement {
  const { providers, modelOptions, activeModel } = useChatModels()
  const { selectModel } = useChatActions()
  const groups = useMemo(
    () => groupModelOptions(modelOptions, providers),
    [modelOptions, providers],
  )
  const isActive = (option: { configId: string; modelId: string }): boolean => {
    return (
      activeModel !== null &&
      option.configId === activeModel.id &&
      option.modelId === activeModel.model
    )
  }
  const nativeMenu = useNativeMenuDrawer({
    open,
    onOpenChange,
    menuId: 'chat-model',
    items: groups.map((group) => ({
      type: 'section',
      title: group.label,
      items: group.options.map(({ option, value }) => ({
        type: 'action',
        id: value,
        title: option.label,
        checked: isActive(option),
      })),
    })),
    onSelect: (id) => {
      const picked = groups.flatMap((group) => group.options).find(({ value }) => value === id)
      if (picked !== undefined) {
        selectModel({ configId: picked.option.configId, modelId: picked.option.modelId })
      }
    },
  })

  return (
    <Drawer open={open && !nativeMenu} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Choose a model">
        <DrawerTitle>Model</DrawerTitle>
        <div className="flex max-h-[60dvh] flex-col gap-6 overflow-y-auto px-4 pb-8 pt-4">
          {groups.map((group) => (
            <SettingsGroup key={group.configId} header={group.label}>
              {group.options.map(({ option, value }) => (
                <SettingsSelectRow
                  key={value}
                  label={option.label}
                  selected={isActive(option)}
                  onPress={() => {
                    selectModel({ configId: option.configId, modelId: option.modelId })
                    onOpenChange(false)
                  }}
                />
              ))}
            </SettingsGroup>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
