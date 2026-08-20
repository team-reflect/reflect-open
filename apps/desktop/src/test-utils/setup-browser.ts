import { beforeEach } from 'vitest'
import '@/styles/index.css'
import { resetLocalStorageStores } from '@/lib/local-storage'
import { resetSessionStorageStores } from '@/lib/session-storage'

// A store holds its key's value in memory, so a test that clears
// localStorage or sessionStorage would otherwise keep reading what the
// previous one left behind.
beforeEach(() => {
  resetLocalStorageStores()
  resetSessionStorageStores()
})
