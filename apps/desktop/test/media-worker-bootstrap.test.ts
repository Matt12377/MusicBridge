import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { resolveDesktopMediaWorker } from '../src/main/media-worker-bootstrap.js'
import { createRustMediaWorkerPool, RustMediaWorkerError } from '../../../packages/bridge-core/src/library/rust-media-worker.js'
import { DEFAULT_METADATA_READ_BUDGET } from '../../../packages/bridge-core/src/library/metadata-reader-types.js'

async function fixture() {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const binary = process.env.MB_MEDIA_WORKER_BINARY
  assert.ok(binary, '回归需要已构建的真实 Rust Worker')
  const bytes = await readFile(binary), binarySha256 = createHash('sha256').update(bytes).digest('hex')
  const directory = await mkdtemp(path.join(temporary, 'mb-media-bootstrap-'))
  const appDirectory = path.join(directory, 'desktop'), entryDirectory = path.join(appDirectory, 'dist/main')
  const resourcesDirectory = path.join(directory, 'Resources')
  await mkdir(entryDirectory, { recursive: true })
  async function stage(root: string) {
    const target = path.join(root, 'media-worker', `${process.platform}-${process.arch}`, 'bin',
      process.platform === 'win32' ? 'musicbridge-media-worker.exe' : 'musicbridge-media-worker')
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(binary!, target); await chmod(target, 0o700)
    return target
  }
  return { appDirectory, entryDirectory, resourcesDirectory, binarySha256, stage }
}

test('开发文件入口：从 dist/main 定位真实 Worker，校验摘要后可解析合成音频', async () => {
  const f = await fixture(), binaryPath = await f.stage(path.join(f.appDirectory, 'native'))
  const resolved = await resolveDesktopMediaWorker({ ...f, packaged: false })
  assert.equal(resolved.binaryPath, binaryPath)
  const worker = createRustMediaWorkerPool(resolved)
  try {
    const bytes = await readFile(new URL('../../../packages/bridge-core/test/fixtures/mbrs003/audio/fixtures/core-wav.wav', import.meta.url))
    const metadata = await worker.readMetadata({ size: bytes.length, budget: DEFAULT_METADATA_READ_BUDGET,
      async read(offset, length) { return bytes.subarray(offset, offset + length) } })
    assert.equal(metadata.status, 'ok')
  } finally { await worker.close() }
})

test('打包入口：仅采用 Resources 中的编译身份，忽略开发目录的资源', async () => {
  const f = await fixture(), binaryPath = await f.stage(f.resourcesDirectory)
  assert.equal((await resolveDesktopMediaWorker({ ...f, packaged: true })).binaryPath, binaryPath)
  await assert.rejects(resolveDesktopMediaWorker({ ...f, packaged: false }), (error: unknown) => error instanceof RustMediaWorkerError && error.code === 'WORKER_FAILED')
})

test('启动资源缺失或摘要改变时提前拒绝，不能旁找另一个 Worker', async () => {
  const f = await fixture()
  await assert.rejects(resolveDesktopMediaWorker({ ...f, packaged: false }), (error: unknown) => error instanceof RustMediaWorkerError && error.code === 'WORKER_FAILED')
  await f.stage(path.join(f.appDirectory, 'native'))
  await assert.rejects(resolveDesktopMediaWorker({ ...f, packaged: false, binarySha256: '0'.repeat(64) }),
    (error: unknown) => error instanceof RustMediaWorkerError && error.code === 'WORKER_FAILED')
})
