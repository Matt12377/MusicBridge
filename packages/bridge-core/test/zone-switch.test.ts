import assert from 'node:assert/strict'
import test from 'node:test'

import { switchRoonZoneAfterStop } from '../src/roon/zone-switch.js'

test('切换 Zone 先停止当前会话，再保存新 output', async () => {
  const events: string[] = []
  await switchRoonZoneAfterStop({
    hasActivePlayback: true,
    stop: async () => { events.push('stop') },
    select: () => { events.push('select') },
  })
  assert.deepEqual(events, ['stop', 'select'])
})

test('停止失败时不切 Zone；切换失败时播放仍保持已停止', async () => {
  let selected = false
  await assert.rejects(() => switchRoonZoneAfterStop({
    hasActivePlayback: true,
    stop: async () => { throw new Error('stop failed') },
    select: () => { selected = true },
  }))
  assert.equal(selected, false)

  let stopped = false
  await assert.rejects(() => switchRoonZoneAfterStop({
    hasActivePlayback: true,
    stop: async () => { stopped = true },
    select: () => { throw new Error('select failed') },
  }))
  assert.equal(stopped, true)
})
