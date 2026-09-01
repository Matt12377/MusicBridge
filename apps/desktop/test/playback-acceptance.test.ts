import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const rendererRoot = path.resolve('src/renderer/src')

test('playlist track playback constructs the collection queue before playback starts', async () => {
  const app = await readFile(path.join(rendererRoot, 'App.vue'), 'utf8')
  const playStart = app.indexOf('function playPlaylistTrack')
  const playEnd = app.indexOf('function playAllPlaylist', playStart)
  const implementation = app.slice(playStart, playEnd)

  assert.match(implementation, /replaceAndPlayCollection/)
  assert.doesNotMatch(implementation, /window\.musicBridge\.play\(/)
})

test('Provider playback exposes seek when the selected Roon zone allows it', async () => {
  const app = await readFile(path.join(rendererRoot, 'App.vue'), 'utf8')
  const seekStart = app.indexOf('async function seekPlayback')
  const seekEnd = app.indexOf('async function loadZones', seekStart)
  const implementation = app.slice(seekStart, seekEnd)

  assert.doesNotMatch(implementation, /playbackSource\.value !== 'roon'/)
  assert.match(app, /:seek-allowed="selectedZone\?\.seekAllowed === true"/)
})

test('queue inspector uses the available panel height instead of a fixed 420px viewport', async () => {
  const style = await readFile(path.join(rendererRoot, 'style.css'), 'utf8')

  assert.match(style, /\.inspector-queue\s*\{[^}]*flex:\s*1/u)
  assert.match(style, /\.queue-upcoming-viewport\s*\{[^}]*flex:\s*1/u)
  assert.doesNotMatch(style, /\.queue-upcoming-viewport\.is-virtualized\s*\{[^}]*max-height:\s*420px/u)
})
