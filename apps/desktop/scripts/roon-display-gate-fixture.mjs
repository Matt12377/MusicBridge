import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
import { WebSocketServer } from 'ws'
import { RoonDisplayConnection } from '../src/main/roon-display-connection.ts'
import { RoonDisplayLyricsStore } from '../../../packages/bridge-core/src/lyrics/roon-display-store.ts'
import { createLocalTrackSignature } from '../../../packages/bridge-core/src/lyrics-matching/signature.ts'

async function main() {
const directory = process.env.MUSIC_BRIDGE_DISPLAY_GATE_DIR
assert.ok(directory)
await mkdir(path.join(directory, 'user-data'), { recursive: true })
app.setPath('userData', path.join(directory, 'user-data'))
app.on('window-all-closed', () => {})
const store = new RoonDisplayLyricsStore()
const events = []
let connection
let server
let external
let websocket
let externalHits = 0
const sockets = new Set()
const track = { title: '合成曲目', artist: '合成艺人', album: '合成专辑', durationMs: 20000 }
const context = { kind: 'local', zoneId: 'zone-one', signature: createLocalTrackSignature({ ...track, artists: [track.artist] }) }
const frame = (name, body) => `MOO/1 CONTINUE ${name}\nRequest-Id: 1\n\n${JSON.stringify(body)}`
const waitFor = async (predicate, description, timeout = 5000) => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    assert.ok(Date.now() < deadline, description)
    await delay(40)
  }
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const deadline = setTimeout(() => { console.error('ROON_DISPLAY_GATE_TIMEOUT'); app.exit(1) }, 45000)
try {
  await app.whenReady()
  console.log('ROON_DISPLAY_GATE_READY')
  external = createServer((_req, res) => { externalHits++; res.end('禁止访问') })
  await listen(external)
  server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(`<script>
      const ws = new WebSocket('ws://' + location.host + '/ws');
      fetch('http://127.0.0.1:${external.address().port}/blocked').catch(() => {});
      window.open('http://127.0.0.1:${external.address().port}/popup');
    </script>`)
  })
  await listen(server)
  websocket = new WebSocketServer({ server })
  let connections = 0
  websocket.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    connections++
    socket.send(frame('Subscribed', { zones: [{ zone_id: 'zone-one', now_playing: {
      three_line: { line1: track.title, line2: track.artist, line3: track.album }, length: 20,
    } }] }))
    socket.send(frame('LyricsChanged', { zone_id: 'zone-one', key: 'synthetic-private-key', lrc: '[00:00.00]合成第一行\n[00:05.00]合成第二行' }))
  })
  const options = { settingsPath: path.join(directory, 'settings.json'), forward: async event => {
    events.push(event)
    store.update(event)
  } }
  connection = new RoonDisplayConnection(options)
  const url = `http://127.0.0.1:${server.address().port}/display/`
  await connection.configure(url)
  await waitFor(() => store.read(context)?.status === 'ready', '首连未取得歌词')
  assert.equal(connection.getSettings().status, 'connected')
  assert.equal(store.read(context).source, 'roon-display')
  assert.equal(store.read(context).lines.length, 2)
  assert.equal(JSON.stringify(events).includes('synthetic-private-key'), false)
  assert.deepEqual(JSON.parse(await readFile(options.settingsPath, 'utf8')), { url })
  assert.equal((await stat(options.settingsPath)).mode & 0o777, 0o600)
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  const page = BrowserWindow.getAllWindows()[0].webContents
  const preferences = page.getLastWebPreferences()
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.webSecurity, true)
  assert.ok(!preferences.preload)
  assert.equal(page.session.isPersistent(), false)
  await delay(100)
  assert.equal(externalHits, 0)
  for (const socket of sockets) socket.close()
  await waitFor(() => connection.getSettings().status === 'disconnected', '未发现连接中断')
  assert.equal(store.read(context).status, 'unavailable')
  await waitFor(() => connections >= 2 && store.read(context)?.status === 'ready', '未自动重连', 14000)
  const before = connections
  connection.restart()
  assert.equal(store.read(context).status, 'unavailable')
  await waitFor(() => connections > before && store.read(context)?.status === 'ready', 'Core 重启未清词重连')
  await assert.rejects(connection.configure('https://example.com/display/'))
  assert.equal(connection.getSettings().url, url)
  connection.stop()
  connection = new RoonDisplayConnection(options)
  await connection.restore()
  await waitFor(() => store.read(context)?.status === 'ready', '未恢复持久化设置')
  await Promise.all([connection.configure(url), connection.configure('')])
  assert.deepEqual(connection.getSettings(), { url: '', status: 'disabled' })
  assert.deepEqual(JSON.parse(await readFile(options.settingsPath, 'utf8')), { url: '' })
  assert.equal(store.read(context), undefined)
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  console.log('ROON_DISPLAY_GATE_PASS')
  app.exit(0)
} catch (error) {
  console.error('ROON_DISPLAY_GATE_ASSERT', error)
  app.exit(1)
} finally {
  clearTimeout(deadline)
  connection?.stop()
  for (const socket of sockets) socket.terminate()
  websocket?.close()
  server?.close()
  external?.close()
}
}
void main().catch(error => { console.error(error); app.exit(1) })
