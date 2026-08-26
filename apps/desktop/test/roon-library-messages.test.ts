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

test('P1-D exposes distinct real capability failures instead of one generic fallback', () => {
  assert.equal(roonLibraryMessage('ROON_CORE_NOT_CONNECTED'), 'Roon Core 未连接。')
  assert.equal(roonLibraryMessage('ROON_LIBRARY_UNAVAILABLE'), 'Roon Library service 不可用。')
  assert.equal(roonLibraryMessage('ROON_ALBUM_HIERARCHY_INVALID'), 'Roon 返回的专辑层级无效，请返回列表后重试。')
  assert.equal(roonLibraryMessage('ROON_TRACK_ACTION_UNAVAILABLE'), '这首曲目的 Roon 播放操作不可用。')
})

test('P1-D preserves public error codes after Electron serializes an IPC rejection', () => {
  const serialized = new Error(
    "Error invoking remote method 'roon:library:genres': PublicIpcError: [ROON_LIBRARY_UNAVAILABLE] Roon Library is not available",
  )

  assert.equal(
    roonLibraryMessage(serialized, { roonStatus: 'ready' }),
    'Roon Library service 不可用。',
  )
  assert.equal(
    roonLibraryMessage(serialized, { roonStatus: 'disconnected' }),
    'Roon Core 未连接。',
  )
  assert.equal(
    roonLibraryMessage(serialized, {
      roonStatus: 'discovering',
      remoteCoreDevelopment: false,
    }),
    'Roon Core 未连接。',
  )
})
