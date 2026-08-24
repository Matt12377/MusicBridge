import assert from 'node:assert/strict'
import test from 'node:test'

import { roonLibraryMessage } from '../src/renderer/src/roonLibraryMessages.js'

test('remote development explains that the Dev Mac Roon extension must be enabled', () => {
  assert.equal(
    roonLibraryMessage('NOT_READY', {
      roonStatus: 'discovering',
      remoteCoreDevelopment: true,
    }),
    'Roon Dev Mac 扩展尚未启用，请在 Roon 设置 → 扩展中启用“Music Bridge for Roon — Dev Mac”后重试。',
  )
})

test('generic Roon failures keep the existing bounded message', () => {
  assert.equal(
    roonLibraryMessage('ROON_LIBRARY_REQUEST_FAILED', {
      roonStatus: 'ready',
      remoteCoreDevelopment: true,
    }),
    'Roon Library 请求失败，请检查 Core 连接。',
  )
})
