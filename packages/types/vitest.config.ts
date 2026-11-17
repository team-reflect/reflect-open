import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: { label: 'types', color: 'white' },
    environment: 'node',
  },
})
