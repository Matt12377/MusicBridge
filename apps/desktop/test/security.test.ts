import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBrowserWindowWebPreferences,
  getWindowOpenDecision,
  isNavigationAllowed,
} from '../src/main/security.js'

test('main BrowserWindow security preferences are fail-closed', () => {
  assert.deepEqual(buildBrowserWindowWebPreferences(), {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
  })
})

test('navigation is rejected and window.open is denied', () => {
  assert.equal(isNavigationAllowed('musicbridge://app/index.html'), true)
  assert.equal(isNavigationAllowed('file:///local/index.html'), false)
  assert.equal(isNavigationAllowed('https://example.invalid'), false)
  assert.equal(isNavigationAllowed('musicbridge://app/other.html'), false)
  assert.deepEqual(getWindowOpenDecision(), { action: 'deny' })
})
