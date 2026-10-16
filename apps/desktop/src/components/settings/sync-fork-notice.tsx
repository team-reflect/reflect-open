import type { ReactElement } from 'react'
import type { DuplicateIdGroup } from '@reflect/core'

interface SyncForkNoticeProps {
  groups: DuplicateIdGroup[]
}

/**
 * The sync-fork review notice (Plan 17): two files claiming one frontmatter
 * `id` — the same note renamed differently on two devices, now existing as
 * separate files. Repair is the user's call, never automatic. Renders nothing
 * when there are no forks.
 */
export function SyncForkNotice({ groups }: SyncForkNoticeProps): ReactElement | null {
  if (groups.length === 0) {
    return null
  }
  return (
    <div className="text-xs text-amber-700 dark:text-amber-300">
      <p>
        {groups.length === 1
          ? '1 note was renamed differently on two devices and now exists as separate files'
          : `${groups.length} notes were renamed differently on two devices and now exist as separate files`}{' '}
        — merge by hand, then delete the copy you don’t want:
      </p>
      <ul className="mt-1 list-disc pl-4">
        {groups.map((group) => (
          <li key={group.id}>{group.paths.join('  ·  ')}</li>
        ))}
      </ul>
    </div>
  )
}
