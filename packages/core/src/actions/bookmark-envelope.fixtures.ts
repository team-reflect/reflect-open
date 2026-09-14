import type { BookmarkEnvelope } from './bookmark-envelope'
const envelope: BookmarkEnvelope = {
  version: 2,
  kind: 'x-bookmark',
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  source: 'extension',
  capturedAt: '2026-09-09T04:00:00Z',
  data: { id: '20', createdAt: '', author: { name: '', handle: '' }, body: [] },
}
export default {
  accepted: [{ envelope }, { envelope: { ...envelope, extra: 'ignore me' } }],
  spooled: [envelope],
  rejected: [
    { envelope: { ...envelope, version: 1 } },
    { envelope: { ...envelope, data: { ...envelope.data, id: 20 } } },
    { envelope: { ...envelope, data: { ...envelope.data, id: '0' } } },
    { envelope: { ...envelope, capturedAt: '2026-02-31T04:00:00Z' } },
  ],
}
