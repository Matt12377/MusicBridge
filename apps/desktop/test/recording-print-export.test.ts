import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const bytes = Buffer.from('%PDF-1.7\n合成边界测试，不是真实排版证据\n%%EOF\n')
const sha = createHash('sha256').update(bytes).digest('hex')
async function subject() {
  const module = await import('../src/main/recording-print-export.js').catch(() => ({}))
  assert.ok('exportRecordingPrintPdf' in module, '缺少精确印刷文件安全导出')
  return (module as typeof import('../src/main/recording-print-export.js')).exportRecordingPrintPdf
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mb-print-export-'))
  const request = { recordingId: randomUUID(), artifactId: randomUUID(), expectedPdfSha256: sha }
  const payload = { artifactId: request.artifactId, pdfSha256: sha, size: bytes.length, pdfBase64: bytes.toString('base64') }
  let current = true, reads = 0
  const options = {
    request,
    readPdf: async () => { reads++; return structuredClone(payload) },
    select: async () => ({ canceled: false, filePath: path.join(root, '新卡片.pdf') }),
    assertCurrent: async () => { if (!current) throw new Error('库已切换 /private/secret') },
    isCurrent: () => current,
  }
  return { root, request, payload, options, reads: () => reads, switch: () => { current = false }, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('精确PDF导出写完整原始字节、回执不含路径且临时文件清理', async () => {
  const run = await subject(), f = await fixture()
  try {
    const result = await run(f.options)
    assert.deepEqual(result, { state: 'exported', artifactId: f.request.artifactId, pdfSha256: sha, size: bytes.length })
    assert.deepEqual(await readFile(path.join(f.root, '新卡片.pdf')), bytes)
    assert.deepEqual(await readdir(f.root), ['新卡片.pdf'])
    assert.equal(f.reads(), 2, '保存框返回后必须重读精确Artifact')
  } finally { await f.cleanup() }
})
test('保存框取消零写入，不误报已导出或二次读取', async () => {
  const run = await subject(), f = await fixture()
  try {
    assert.deepEqual(await run({ ...f.options, select: async () => ({ canceled: true }) }), { state: 'cancelled' })
    assert.deepEqual(await readdir(f.root), [])
    assert.equal(f.reads(), 1)
  } finally { await f.cleanup() }
})
test('原生框迟到遇到换库或Artifact字节变化均零发布且隐藏内部细节', async () => {
  const run = await subject()
  for (const change of ['scope', 'bytes', 'hash', 'identity'] as const) {
    const f = await fixture()
    try {
      await assert.rejects(run({ ...f.options, select: async () => {
        if (change === 'scope') f.switch()
        if (change === 'bytes') f.payload.pdfBase64 = Buffer.from('bad').toString('base64')
        if (change === 'hash') f.payload.pdfSha256 = 'b'.repeat(64)
        if (change === 'identity') f.payload.artifactId = randomUUID()
        return { canceled: false, filePath: path.join(f.root, '新卡片.pdf') }
      } }), error => error instanceof Error && !error.message.includes('/private/') && /PRINT_EXPORT/u.test(error.message))
      assert.deepEqual(await readdir(f.root), [])
    } finally { await f.cleanup() }
  }
})
test('既有目标及符号链接均不覆盖，目标原字节保持不变', async () => {
  const run = await subject()
  for (const kind of ['file', 'symlink'] as const) {
    const f = await fixture()
    try {
      const target = path.join(f.root, '新卡片.pdf')
      await writeFile(path.join(f.root, '原文件.pdf'), '保留')
      if (kind === 'file') await writeFile(target, '旧文件')
      else await symlink(path.join(f.root, '原文件.pdf'), target)
      await assert.rejects(run(f.options), /PRINT_EXPORT/u)
      assert.equal(await readFile(path.join(f.root, '原文件.pdf'), 'utf8'), '保留')
      assert.equal(await readFile(target, 'utf8'), kind === 'file' ? '旧文件' : '保留')
      assert.deepEqual((await readdir(f.root)).sort(), ['原文件.pdf', '新卡片.pdf'])
    } finally { await f.cleanup() }
  }
})
test('最终异步核库之后、同步发布之前的失效仍拒绝发布；无效PDF在弹框前拒绝', async () => {
  const run = await subject(), f = await fixture()
  try {
    let checks = 0
    await assert.rejects(run({ ...f.options, assertCurrent: async () => { checks++; if (checks === 3) f.switch() } }), /PRINT_EXPORT/u)
    assert.deepEqual(await readdir(f.root), [])
    let dialogs = 0
    f.payload.pdfBase64 += '\n'
    await assert.rejects(run({ ...f.options, assertCurrent: async () => undefined, isCurrent: () => true, select: async () => { dialogs++; return { canceled: true } } }), /PRINT_EXPORT/u)
    assert.equal(dialogs, 0)
  } finally { await f.cleanup() }
})

test('最终核库等待期间临时字节被同长度修改不能发布错误hash的成功回执', async () => {
  const run = await subject(), f = await fixture()
  try {
    let checks = 0
    await assert.rejects(run({ ...f.options, assertCurrent: async () => {
      if (++checks === 3) {
        const temp = (await readdir(f.root)).find(name => name.endsWith('.tmp'))!
        await writeFile(path.join(f.root,temp), Buffer.alloc(bytes.length,65))
      }
    } }), /PRINT_EXPORT/u)
    assert.deepEqual(await readdir(f.root), [])
  } finally { await f.cleanup() }
})

test('发布按名称链接时临时inode被替换或字节被改动，不得返回原hash的成功回执', async () => {
  const run = await subject()
  for (const change of ['inode', 'bytes'] as const) {
    const f = await fixture(), originalLink = fs.linkSync
    try {
      let injected = false
      fs.linkSync = ((source, target) => {
        if (!injected) {
          injected = true
          if (change === 'inode') fs.renameSync(source, path.join(f.root, '保留旧inode.pdf'))
          fs.writeFileSync(source, Buffer.alloc(bytes.length, 65))
        }
        originalLink(source, target)
      }) as typeof fs.linkSync
      syncBuiltinESMExports()
      await assert.rejects(run(f.options), /PRINT_EXPORT_UNCONFIRMED/u)
      assert.equal(injected, true)
      // 身份不确定时保留目标，不以回滚名义删除可能已被外部写者替换的文件。
      assert.deepEqual(await readFile(path.join(f.root, '新卡片.pdf')), Buffer.alloc(bytes.length, 65))
    } finally {
      fs.linkSync = originalLink
      syncBuiltinESMExports()
      await f.cleanup()
    }
  }
})
