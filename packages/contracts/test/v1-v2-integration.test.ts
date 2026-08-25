import assert from 'node:assert/strict'
import test from 'node:test'

import { IPC_VERSION, validateIpcRequest } from '../src/index.js'

test('contracts accepts a bounded Roon library albums request', () => {
  const result = validateIpcRequest({
    version: IPC_VERSION,
    id: 'roon-library-albums',
    command: 'roon.library.albums',
    payload: { page: { offset: 0, limit: 20 } },
  })

  assert.equal(result.ok, true)
})
