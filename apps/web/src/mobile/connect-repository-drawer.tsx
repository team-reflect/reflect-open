import type { ReactElement } from 'react'
import type { RepositoryHost } from '@/components/settings/connect-repository-dialog.tsx'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/mobile/scroll-drawer.tsx'
import { SettingsGroup, SettingsNavRow } from '@/mobile/settings-list.tsx'
import { useGithubConnected } from '@/hooks/use-github-connected.ts'
import { useNativeMenuDrawer } from '@/mobile/native-chrome/native-menu.ts'

interface ConnectRepositoryDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The host the user chose; the caller opens that host's own sheet. */
  onChoose: (host: RepositoryHost) => void
}

/**
 * The mobile one door to a repository: a two-row choice. GitHub goes on to
 * the connect wizard sheet, any other host to the address form sheet.
 */
export function ConnectRepositoryDrawer({
  open,
  onOpenChange,
  onChoose,
}: ConnectRepositoryDrawerProps): ReactElement {
  const githubConnected = useGithubConnected()
  const nativeMenu = useNativeMenuDrawer({
    open,
    onOpenChange,
    menuId: 'connect-repository',
    items: [
      {
        type: 'section',
        title: 'Where is the repository?',
        items: [
          {
            type: 'action',
            id: 'github',
            title: githubConnected ? 'GitHub (signed in)' : 'GitHub (sign in first)',
          },
          { type: 'action', id: 'other', title: 'Other host' },
        ],
      },
    ],
    onSelect: (id) => {
      if (id === 'github' || id === 'other') {
        onChoose(id)
      }
    },
  })
  return (
    <Drawer open={open && !nativeMenu} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Connect a repository">
        <DrawerTitle>Connect a repository</DrawerTitle>
        <DrawerBody>
          <SettingsGroup footer="Where is the repository?">
            <SettingsNavRow
              label="GitHub"
              value={githubConnected ? 'Signed in' : 'Sign in first'}
              onPress={() => onChoose('github')}
            />
            <SettingsNavRow label="Other host" onPress={() => onChoose('other')} />
          </SettingsGroup>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  )
}
