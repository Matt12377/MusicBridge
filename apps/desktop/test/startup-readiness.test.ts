import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { canLoadAuthorizedLibrary } from '../src/renderer/src/core-readiness.js'

test('authorized library requests wait until the utility Core is ready', () => {
  assert.equal(canLoadAuthorizedLibrary('authorized', 'starting'), false)
  assert.equal(canLoadAuthorizedLibrary('authorized', 'degraded'), false)
  assert.equal(canLoadAuthorizedLibrary('authorized', undefined), false)
  assert.equal(canLoadAuthorizedLibrary('waiting', 'ready'), false)
  assert.equal(canLoadAuthorizedLibrary('authorized', 'ready'), true)
  assert.equal(canLoadAuthorizedLibrary('authorized', 'ready', 'checking'), false)
  assert.equal(canLoadAuthorizedLibrary('authorized', 'ready', 'starting'), false)
  assert.equal(canLoadAuthorizedLibrary('authorized', 'ready', 'reconnecting'), false)
  assert.equal(canLoadAuthorizedLibrary('authorized', 'ready', 'ready'), true)
  assert.equal(canLoadAuthorizedLibrary('authorized', 'ready', 'idle'), true)
})

test('startup does not replay the initial auth snapshot after receiving the live auth event', async () => {
  const app = await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')

  assert.match(app, /authEventReceived = true\s+applyAuthState/u)
  assert.match(app, /if \(!authEventReceived\) applyAuthState\(initialAuthState\)/u)
})

test('account state requests also wait for the remote Core tunnel to become stable', async () => {
  const app = await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')
  const loaderStart = app.indexOf('async function loadAccountState')
  const loaderEnd = app.indexOf('async function refreshAccountProfile', loaderStart)
  const loader = app.slice(loaderStart, loaderEnd)

  assert.match(
    loader,
    /isCoreRuntimeStable\(coreState\.value\?\.runtime, remoteCoreState\.value\.status\)/u,
  )
})

test('a restarted Core starts a fresh authorized library load instead of preserving the failed generation', async () => {
  const app = await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')
  const listenerStart = app.indexOf('removeCoreListener = window.musicBridge.onCoreEvent')
  const listenerEnd = app.indexOf("if (event.event === 'auth.changed')", listenerStart)
  const listener = app.slice(listenerStart, listenerEnd)

  assert.match(
    listener,
    /if \(event\.event === 'core\.ready'\) \{\s*authorizedLibraryLoadStarted = false\s*loadAuthorizedLibraryWhenReady\(\)\s*\}/u,
  )
})
