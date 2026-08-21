import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  getRendererAssetPath,
  isAllowedRendererRequest,
  rendererContentType,
} from '../src/main/renderer-protocol.js'

test('custom renderer protocol accepts only the app origin and GET/HEAD paths', () => {
  assert.equal(isAllowedRendererRequest('musicbridge://app/index.html', 'GET'), true)
  assert.equal(isAllowedRendererRequest('musicbridge://app/assets/main.js', 'HEAD'), true)
  assert.equal(isAllowedRendererRequest('musicbridge://other/index.html', 'GET'), false)
  assert.equal(isAllowedRendererRequest('https://example.invalid/index.html', 'GET'), false)
  assert.equal(isAllowedRendererRequest('musicbridge://app/index.html?raw=1', 'GET'), false)
  assert.equal(isAllowedRendererRequest('musicbridge://app/index.html', 'POST'), false)
})

test('renderer asset mapping rejects traversal and symlink escapes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-renderer-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-outside-'))
  try {
    await mkdir(path.join(root, 'assets'))
    await writeFile(path.join(root, 'index.html'), '<!doctype html>')
    await writeFile(path.join(root, 'assets', 'main.js'), 'export {}')
    await writeFile(path.join(outside, 'secret.txt'), 'not served')
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'assets', 'escape.txt'))

    assert.equal(await readFile(await getRendererAssetPath(root, '/index.html'), 'utf8'), '<!doctype html>')
    assert.equal(await readFile(await getRendererAssetPath(root, '/assets/main.js'), 'utf8'), 'export {}')
    await assert.rejects(() => getRendererAssetPath(root, '/../outside.txt'))
    await assert.rejects(() => getRendererAssetPath(root, '/assets/escape.txt'))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('renderer protocol uses exact MIME types for packaged assets', () => {
  assert.equal(rendererContentType('/index.html'), 'text/html; charset=utf-8')
  assert.equal(rendererContentType('/assets/main.js'), 'text/javascript; charset=utf-8')
  assert.equal(rendererContentType('/assets/main.css'), 'text/css; charset=utf-8')
  assert.equal(rendererContentType('/assets/icon.svg'), 'image/svg+xml')
  assert.equal(rendererContentType('/assets/data.bin'), 'application/octet-stream')
})
