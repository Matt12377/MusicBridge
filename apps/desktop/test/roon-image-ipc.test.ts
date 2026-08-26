import assert from 'node:assert/strict'
import test from 'node:test'
import {
  settleRoonImageIpc,
  unwrapRoonImageIpc,
} from '../src/roon-image-ipc.js'
import { readPublicIpcErrorCode } from '../src/renderer/src/roonLibraryMessages.js'

test('Roon 图片 IPC 将预期缺图结算为安全 envelope，避免 Electron handler 拒绝日志', async () => {
  const envelope = await settleRoonImageIpc(
    async () => {
      throw Object.assign(new Error('private Roon detail'), { code: 'ROON_IMAGE_UNAVAILABLE' })
    },
    (error) => ({
      code: (error as { code: 'ROON_IMAGE_UNAVAILABLE' }).code,
      message: 'Roon image is unavailable',
    }),
  )

  assert.deepEqual(envelope, {
    ok: false,
    error: {
      code: 'ROON_IMAGE_UNAVAILABLE',
      message: 'Roon image is unavailable',
    },
  })
  assert.doesNotMatch(JSON.stringify(envelope), /private Roon detail/u)
  let rendererError: unknown
  try {
    unwrapRoonImageIpc(envelope)
  } catch (error) {
    rendererError = error
  }
  assert.equal(readPublicIpcErrorCode(rendererError), 'ROON_IMAGE_UNAVAILABLE')
  const serializedError = new Error(
    rendererError instanceof Error ? rendererError.message : String(rendererError),
  )
  assert.equal(readPublicIpcErrorCode(serializedError), 'ROON_IMAGE_UNAVAILABLE')
})

test('Roon 图片 IPC 成功 envelope 保留受控图片结果', async () => {
  const value = {
    contentType: 'image/jpeg' as const,
    body: new Uint8Array([0xff, 0xd8, 0xff]),
  }
  const envelope = await settleRoonImageIpc(async () => value, () => ({
    code: 'INTERNAL_ERROR',
    message: 'Roon image request failed',
  }))

  assert.deepEqual(unwrapRoonImageIpc(envelope), value)
})
