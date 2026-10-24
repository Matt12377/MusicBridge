import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CredentialVault,
  recordCredentialStage,
  type AsyncSafeStorage,
  type CredentialVaultReadResult,
} from '../src/main/credential-vault.js'
import { readLibraryOperationLine } from '../../../packages/bridge-core/src/shared/library-operation-log.js'

class FakeSafeStorage implements AsyncSafeStorage {
  available = true
  reencryptOnRead = false
  encryptCalls = 0

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.available
  }

  async encryptStringAsync(value: string): Promise<Buffer> {
    this.encryptCalls += 1
    return Buffer.from(`enc:${[...value].reverse().join('')}`, 'utf8')
  }

  async decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    const encoded = encrypted.toString('utf8')
    if (!encoded.startsWith('enc:')) throw new Error('corrupt fixture')
    return {
      result: [...encoded.slice(4)].reverse().join(''),
      shouldReEncrypt: this.reencryptOnRead,
    }
  }
}

async function makeTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'musicbridge-task013-'))
}

function makeVault(root: string, storage: FakeSafeStorage): CredentialVault {
  return new CredentialVault({
    filePath: path.join(root, 'data', 'netease.credential'),
    storage,
  })
}

test('safeStorage unavailable rejects saving and creates no plaintext fallback', async () => {
  const root = await makeTempRoot()
  const storage = new FakeSafeStorage()
  storage.available = false
  const vault = makeVault(root, storage)

  await assert.rejects(vault.save('fixture-credential'), /safeStorage encryption is unavailable/)
  assert.deepEqual(await vault.read(), { status: 'missing' } satisfies CredentialVaultReadResult)
})

test('credential is encrypted, mode 600, readable, and deletable', async () => {
  const root = await makeTempRoot()
  const storage = new FakeSafeStorage()
  const vault = makeVault(root, storage)

  await vault.save('fixture-credential')

  const filePath = path.join(root, 'data', 'netease.credential')
  const stat = await lstat(filePath)
  assert.equal(stat.isFile(), true)
  assert.equal(stat.mode & 0o777, 0o600)
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /fixture-credential/)
  assert.deepEqual(await vault.read(), {
    status: 'configured',
    credential: 'fixture-credential',
  } satisfies CredentialVaultReadResult)

  await vault.delete()
  assert.deepEqual(await vault.read(), { status: 'missing' } satisfies CredentialVaultReadResult)
})

test('corrupt or symlinked vault files are invalid without reading their target', async () => {
  const root = await makeTempRoot()
  const storage = new FakeSafeStorage()
  const vault = makeVault(root, storage)
  const filePath = path.join(root, 'data', 'netease.credential')
  await mkdir(path.dirname(filePath), { recursive: true })

  await writeFile(filePath, 'corrupt', { mode: 0o600 })
  assert.deepEqual(await vault.read(), { status: 'invalid' } satisfies CredentialVaultReadResult)

  const targetPath = path.join(root, 'target')
  const symlinkPath = path.join(root, 'symlink-vault')
  await writeFile(targetPath, 'fixture-credential', { mode: 0o600 })
  await chmod(filePath, 0o600)
  await symlink(targetPath, symlinkPath)
  const symlinkVault = new CredentialVault({ filePath: symlinkPath, storage })
  assert.deepEqual(await symlinkVault.read(), { status: 'invalid' } satisfies CredentialVaultReadResult)
})

test('key rotation re-encrypts the credential without exposing it', async () => {
  const root = await makeTempRoot()
  const storage = new FakeSafeStorage()
  storage.reencryptOnRead = true
  const vault = makeVault(root, storage)

  await vault.save('fixture-credential')
  const beforeRead = storage.encryptCalls
  assert.deepEqual(await vault.read(), {
    status: 'configured',
    credential: 'fixture-credential',
  } satisfies CredentialVaultReadResult)
  assert.equal(storage.encryptCalls, beforeRead + 1)
})

test('POC environment credential can be migrated only into encrypted storage', async () => {
  const root = await makeTempRoot()
  const storage = new FakeSafeStorage()
  const vault = makeVault(root, storage)

  assert.equal(await vault.migratePlaintext('fixture-credential'), 'migrated')
  assert.deepEqual(await vault.read(), {
    status: 'configured',
    credential: 'fixture-credential',
  } satisfies CredentialVaultReadResult)
})

test('保险库阶段诊断只输出固定枚举和耗时，成功及轮换沿原读取顺序', async t => {
  const root = await makeTempRoot(), storage = new FakeSafeStorage(), vault = makeVault(root, storage), lines: string[] = []
  t.mock.method(console, 'info', (line: unknown) => { if (typeof line === 'string') lines.push(line) })
  await vault.save('diagnostic-only-synthetic-credential')
  for (const rotate of [false, true]) {
    storage.reencryptOnRead = rotate; lines.length = 0
    assert.equal((await vault.read()).status, 'configured')
    const events = lines.map(readLibraryOperationLine)
    assert.ok(events.every(event => event !== null && Number.isFinite(event.elapsedMs) && event.elapsedMs! >= 0))
    assert.deepEqual(events.map(event => [event!.action, event!.code]), [
      ['startup.provider-auth.vault-file', 'FILE_VALID'], ['startup.provider-auth.vault-availability', 'AVAILABLE'],
      ['startup.provider-auth.vault-read', 'READ'], ['startup.provider-auth.vault-decrypt', 'DECRYPTED'],
      ['startup.provider-auth.vault-validate', 'CREDENTIAL_VALID'],
      ...(rotate ? [['startup.provider-auth.vault-reencrypt', 'REENCRYPTED']] : []),
      ['startup.provider-auth.vault-result', 'CONFIGURED'],
    ])
    const output = lines.join('\n')
    assert.ok(!output.includes('diagnostic-only-synthetic-credential') && !output.includes(root) && !output.includes('enc:'))
  }
  const count = lines.length
  recordCredentialStage('unsafe-stage' as never, 'CONFIGURED', performance.now())
  recordCredentialStage('vault-result', 'SYNTHETIC_SECRET_CODE' as never, performance.now())
  assert.equal(lines.length, count, '未知阶段或枚举不得进入原常开日志')
})

test('保险库诊断区分异步不可用、异常及解密校验轮换失败，不读取原错误或改写原密文', async t => {
  const lines: string[] = []
  t.mock.method(console, 'info', (line: unknown) => { if (typeof line === 'string') lines.push(line) })
  for (const mode of ['unavailable', 'availability-reject', 'decrypt-reject', 'invalid-credential', 'reencrypt-reject', 'reencrypt-invalid'] as const) {
    const root = await makeTempRoot(), storage = new FakeSafeStorage(), vault = makeVault(root, storage)
    await vault.save('diagnostic-synthetic-only')
    const file = path.join(root, 'data', 'netease.credential'), before = await readFile(file)
    let errorReads = 0, decryptCalls = 0
    const failure = Object.defineProperties({}, {
      code: { get() { errorReads++; return 'SYNTHETIC_SECRET_CODE' } },
      message: { get() { errorReads++; return 'synthetic-private-error-message' } },
    })
    const decrypt = storage.decryptStringAsync.bind(storage)
    storage.decryptStringAsync = async encrypted => {
      decryptCalls++
      if (mode === 'decrypt-reject') throw failure
      if (mode === 'invalid-credential') return { result: '\n', shouldReEncrypt: false }
      return decrypt(encrypted)
    }
    if (mode === 'unavailable') storage.available = false
    if (mode === 'availability-reject') storage.isAsyncEncryptionAvailable = async () => { throw failure }
    if (mode.startsWith('reencrypt-')) {
      storage.reencryptOnRead = true
      storage.encryptStringAsync = async () => { if (mode === 'reencrypt-reject') throw failure; return Buffer.alloc(0) }
    }
    lines.length = 0
    const result = await vault.read(), unavailable = mode === 'unavailable' || mode === 'availability-reject'
    assert.equal(result.status, unavailable ? 'unavailable' : 'invalid', mode)
    assert.equal(decryptCalls, unavailable ? 0 : 1); assert.equal(errorReads, 0)
    assert.deepEqual(await readFile(file), before, mode)
    const codes = lines.map(readLibraryOperationLine).map(event => event?.code)
    const expected = { unavailable: 'UNAVAILABLE', 'availability-reject': 'AVAILABILITY_FAILED', 'decrypt-reject': 'DECRYPT_FAILED',
      'invalid-credential': 'VALIDATION_FAILED', 'reencrypt-reject': 'REENCRYPT_FAILED', 'reencrypt-invalid': 'REENCRYPT_INVALID' } as const
    assert.ok(codes.includes(expected[mode]), mode)
    assert.equal(codes.at(-1), unavailable ? 'UNAVAILABLE' : 'INVALID')
    assert.ok(!lines.join('\n').includes('synthetic-private-error-message') && !lines.join('\n').includes('SYNTHETIC_SECRET_CODE'))
  }
})

test('保险库诊断输出异常不改变原已配置结果', async t => {
  const root = await makeTempRoot(), storage = new FakeSafeStorage(), vault = makeVault(root, storage)
  await vault.save('diagnostic-synthetic-only')
  t.mock.method(console, 'info', () => { throw new Error('受控诊断输出故障') })
  assert.equal((await vault.read()).status, 'configured')
})
