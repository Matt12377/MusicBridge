import assert from 'node:assert/strict'
import test from 'node:test'

import { isTrustedRendererSender } from '../src/main/security.js'

test('IPC sender validation accepts only the current custom-protocol app frame', () => {
  assert.equal(
    isTrustedRendererSender({
      senderId: 7,
      windowId: 7,
      frameUrl: 'musicbridge://app/index.html',
    }),
    true,
  )
  assert.equal(
    isTrustedRendererSender({
      senderId: 8,
      windowId: 7,
      frameUrl: 'musicbridge://app/index.html',
    }),
    false,
  )
  assert.equal(
    isTrustedRendererSender({
      senderId: 7,
      windowId: 7,
      frameUrl: 'musicbridge://other/index.html',
    }),
    false,
  )
  assert.equal(
    isTrustedRendererSender({
      senderId: 7,
      windowId: 7,
      frameUrl: 'musicbridge://app/index.html?untrusted=1',
    }),
    false,
  )
  assert.equal(
    isTrustedRendererSender({
      senderId: 7,
      windowId: 7,
      frameUrl: 'musicbridge://app/index.html#search',
    }),
    false,
  )
})
