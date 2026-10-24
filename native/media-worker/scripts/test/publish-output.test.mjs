import assert from 'node:assert/strict'
import { closeSync, linkSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { publishOutputBytes, storageLocations } from '../storage.mjs'

test('发布使用新 inode，旧打开文件保持原内容与新文件权限', () => {
  const directory = mkdtempSync(path.join(storageLocations().commandRoot, 'tmp/mb-worker-publish-'))
  const destination = path.join(directory, 'worker')
  writeFileSync(destination, '旧程序', { mode: 0o755 })
  const old = statSync(destination), descriptor = openSync(destination, 'r')
  try {
    publishOutputBytes(destination, Buffer.from('新程序'), 0o755)
    assert.notEqual(statSync(destination).ino, old.ino)
    assert.equal(readFileSync(descriptor, 'utf8'), '旧程序')
    assert.equal(readFileSync(destination, 'utf8'), '新程序')
    assert.equal(statSync(destination).mode & 0o777, 0o755)
    assert.deepEqual(readdirSync(directory), ['worker'])
  } finally { closeSync(descriptor) }
})

test('发布失败保留旧文件并清理本次临时文件', () => {
  const directory = mkdtempSync(path.join(storageLocations().commandRoot, 'tmp/mb-worker-publish-'))
  const destination = path.join(directory, 'worker')
  writeFileSync(destination, '旧程序', { mode: 0o755 })
  const before = statSync(destination).ino
  assert.throws(() => publishOutputBytes(destination, {}))
  assert.equal(statSync(destination).ino, before)
  assert.equal(readFileSync(destination, 'utf8'), '旧程序')
  assert.deepEqual(readdirSync(directory), ['worker'])
})

test('发布拒绝软链接和硬链接，不改动链接目标', () => {
  const directory = mkdtempSync(path.join(storageLocations().commandRoot, 'tmp/mb-worker-publish-'))
  const original = path.join(directory, 'original'), symbolic = path.join(directory, 'symbolic'), hard = path.join(directory, 'hard')
  writeFileSync(original, '原文件', { mode: 0o755 })
  symlinkSync(original, symbolic)
  assert.throws(() => publishOutputBytes(symbolic, '新程序'))
  linkSync(original, hard)
  assert.throws(() => publishOutputBytes(hard, '新程序'))
  assert.equal(readFileSync(original, 'utf8'), '原文件')
})
