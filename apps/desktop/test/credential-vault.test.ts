import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CredentialVault,
  type AsyncSafeStorage,
  type CredentialVaultReadResult,
} from '../src/main/credential-vault.js'

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
