import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { canLoadAuthorizedLibrary } from '../src/renderer/src/core-readiness.js'

const appUrl = new URL('../src/renderer/src/App.vue', import.meta.url)
const libraryUrl = new URL('../src/renderer/src/composables/application/useNeteaseLibrary.ts', import.meta.url)

function functionSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0 && end > start, `${startMarker} 必须有明确函数边界`)
  return source.slice(start, end)
}

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
  const [app, library] = await Promise.all([readFile(appUrl, 'utf8'), readFile(libraryUrl, 'utf8')])
  const live = functionSection(library, 'function applyAuthState(', 'function applyInitialAuthState(')
  const initial = functionSection(library, 'function applyInitialAuthState(', 'function applyAccountState(')

  assert.match(live, /authEventReceived = true\s+acceptAuthState\(state\)/u)
  assert.match(initial, /if \(!authEventReceived && authOperation === 0\) acceptAuthState\(state\)/u)
  assert.match(app, /event\.event === 'auth\.changed'[\s\S]*?applyAuthState\(event\.payload\.state\)/u)
  assert.match(app, /const authResult = await read\(\(\) => window\.musicBridge\.getAuthState\(\)\)[\s\S]*?applyInitialAuthState\(authResult\.value\)/u)
})

test('account state requests also wait for the remote Core tunnel to become stable', async () => {
  const [app, library] = await Promise.all([readFile(appUrl, 'utf8'), readFile(libraryUrl, 'utf8')])
  const loader = functionSection(library, 'async function loadAccountState(', 'async function refreshAccountProfile(')

  assert.match(
    loader,
    /if \(!isCoreRuntimeStable\(getCoreRuntime\(\), getRemoteStatus\(\)\)\)[\s\S]*?return/u,
  )
  assert.match(loader, /if \(disposed \|\| operation !== accountOperation \|\| !isCoreRuntimeStable\(getCoreRuntime\(\), getRemoteStatus\(\)\)\) return/u)
  assert.match(app, /getCoreRuntime: \(\) => coreState\.value\?\.runtime/u)
  assert.match(app, /getRemoteStatus: \(\) => remoteCoreState\.value\.status/u)
})

test('a restarted Core starts a fresh authorized library load instead of preserving the failed generation', async () => {
  const [app, library] = await Promise.all([readFile(appUrl, 'utf8'), readFile(libraryUrl, 'utf8')])
  const listener = functionSection(app, 'onCoreEvent: event => {', "if (event.event === 'auth.changed')")
  const reset = functionSection(library, 'function resetAuthorizedLoadStarted(', 'async function loadLiked(')
  const loader = functionSection(library, 'function loadAuthorizedLibraryWhenReady(', 'function acceptAuthState(')

  assert.match(
    listener,
    /if \(event\.event === 'core\.ready'\) \{\s*resetAuthorizedLoadStarted\(\)\s*loadAuthorizedLibraryWhenReady\(\)\s*\}/u,
  )
  assert.match(reset, /authorizedLibraryLoadStarted = false/u)
  assert.match(loader, /if \(authorizedLibraryLoadStarted \|\| !canLoadPrivate\(\)\) return[\s\S]*?authorizedLibraryLoadStarted = true/u)
})
