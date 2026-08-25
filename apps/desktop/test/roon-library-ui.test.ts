import assert from 'node:assert/strict'
import test from 'node:test'

import { appendRoonPage, emptyRoonPage } from '../src/renderer/src/composables/roonLibraryPagination.js'

test('Roon library pagination starts empty and preserves the requested page size', () => {
  assert.deepEqual(emptyRoonPage(18), {
    items: [],
    offset: 0,
    limit: 18,
    total: 0,
    hasMore: false,
  })
})

test('Roon library pagination de-duplicates runtime references without reordering', () => {
  const first = {
    items: [
      { reference: 'musicbridge-v2-entity-a', kind: 'album' as const, title: 'A' },
      { reference: 'musicbridge-v2-entity-b', kind: 'album' as const, title: 'B' },
    ],
    offset: 0,
    limit: 2,
    total: 3,
    hasMore: true,
  }
  const second = {
    items: [
      { reference: 'musicbridge-v2-entity-b', kind: 'album' as const, title: 'B (repeat)' },
      { reference: 'musicbridge-v2-entity-c', kind: 'album' as const, title: 'C' },
    ],
    offset: 2,
    limit: 2,
    total: 3,
    hasMore: false,
  }

  assert.deepEqual(appendRoonPage(first, second), {
    items: [first.items[0], first.items[1], second.items[1]],
    offset: 2,
    limit: 2,
    total: 3,
    hasMore: false,
  })
})
