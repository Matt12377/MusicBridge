import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTestBridgeRuntime } from '../src/runtime.js'
import { authorizeSourceDirectory } from '../src/recording/source-files.js'

test('合成 Runtime 把恢复内容保护根动态传给 Logic ZIP 另存授权', async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-zip-runtime-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = { ...await authorizeSourceDirectory(directory), id: randomUUID() }
  const binding = { protectedRoots: [root], open: async () => { throw new Error('本测试不得读取恢复内容') } }
  const runtime = createTestBridgeRuntime({ backupContentBinding: binding })
  t.after(() => runtime.shutdown())
  const datasetId = runtime.commandOutbox!.context().datasetId
  await assert.rejects(runtime.preparationZips!.authorizeTarget({
    targetId: randomUUID(), absolute: path.join(directory, 'Logic.zip'), parentPath: directory,
    parentDev: root.dev, parentIno: root.ino, datasetId, scopeId: randomUUID(), generation: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), /目标|失效|ZIP/u)
})
