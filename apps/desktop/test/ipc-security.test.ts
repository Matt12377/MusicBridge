import assert from 'node:assert/strict'
import test from 'node:test'

import { isTrustedRendererSender } from '../src/main/security.js'

test('IPC sender validation accepts only the current local file frame', () => {
  assert.equal(
    isTrustedRendererSender({
      senderId: 7,
      windowId: 7,
      frameUrl: 'file:///Applications/Music%20Bridge/index.html',
    }),
    true,
  )
  assert.equal(
    isTrustedRendererSender({
      senderId: 8,
      windowId: 7,
      frameUrl: 'file:///Applications/Music%20Bridge/index.html',
    }),
    false,
  )
  assert.equal(
    isTrustedRendererSender({
      senderId: 7,
      windowId: 7,
      frameUrl: 'https://example.invalid/index.html',
    }),
    false,
  )
  assert.equal(
    isTrustedRendererSender({
      senderId: 7,
      windowId: 7,
      frameUrl: 'file:///Applications/Music%20Bridge/index.html?untrusted=1',
    }),
    false,
  )
})
