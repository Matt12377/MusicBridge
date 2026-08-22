import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CredentialVault, type AsyncSafeStorage } from '../src/main/credential-vault.js'
import {
  logoutProviderCredential,
  provisionProviderCredential,
  restoreProviderCredential,
} from '../src/main/credential-provisioning.js'

class FakeSafeStorage implements AsyncSafeStorage {
  available = true

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.available
  }

  async encryptStringAsync(value: string): Promise<Buffer> {
    return Buffer.from(`enc:${[...value].reverse().join('')}`, 'utf8')
  }

  async decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    const encoded = encrypted.toString('utf8')
    if (!encoded.startsWith('enc:')) throw new Error('corrupt fixture')
    return {
      result: [...encoded.slice(4)].reverse().join(''),
      shouldReEncrypt: false,
    }
  }
}

async function makeVault(storage: FakeSafeStorage): Promise<CredentialVault> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-task013-provision-'))
  return new CredentialVault({
    filePath: path.join(root, 'data', 'netease.credential'),
    storage,
  })
}

function makeSupervisor() {
  const calls: Array<{ command: string; payload: unknown }> = []
  let verification: 'authorized' | 'expired' | 'unavailable' = 'authorized'
  return {
    calls,
    setVerification(value: 'authorized' | 'expired' | 'unavailable') {
      verification = value
    },
    async verifyCredential(credential: string): Promise<'authorized' | 'expired' | 'unavailable'> {
      calls.push({ command: 'auth.verifyCredential', payload: { credential } })
      return verification
    },
    async setCredential(credential: string): Promise<unknown> {
      calls.push({ command: 'auth.setCredential', payload: { credential } })
      return {
        runtime: 'ready',
        roon: 'paired',
        provider: 'configured',
        activeStreamCount: 0,
        activePlaybackPresent: false,
      }
    },
    async clearCredential(): Promise<unknown> {
      calls.push({ command: 'auth.clearCredential', payload: {} })
      return {
        runtime: 'ready',
        roon: 'paired',
        provider: 'missing',
        activeStreamCount: 0,
        activePlaybackPresent: false,
      }
    },
  }
}

test('provision migrates environment input, removes it from Core environment, and sends only a controlled request', async () => {
  const storage = new FakeSafeStorage()
  const vault = await makeVault(storage)
  const supervisor = makeSupervisor()
  const environment = { NETEASE_COOKIE: 'fixture-credential' }

  assert.equal(
    await provisionProviderCredential({ vault, core: supervisor, environment }),
    'configured',
  )
  assert.equal(environment.NETEASE_COOKIE, undefined)
  assert.deepEqual(supervisor.calls.map(({ command }) => command), [
    'auth.verifyCredential',
    'auth.setCredential',
  ])
  assert.deepEqual(await vault.read(), {
    status: 'configured',
    credential: 'fixture-credential',
  })
})

test('safeStorage failure refuses migration and does not send plaintext to Core', async () => {
  const storage = new FakeSafeStorage()
  storage.available = false
  const vault = await makeVault(storage)
  const supervisor = makeSupervisor()
  const environment = { NETEASE_COOKIE: 'fixture-credential' }

  assert.equal(
    await provisionProviderCredential({ vault, core: supervisor, environment }),
    'unavailable',
  )
  assert.equal(environment.NETEASE_COOKIE, undefined)
  assert.deepEqual(supervisor.calls, [])
})

test('logout clears Core memory before deleting the encrypted credential file', async () => {
  const storage = new FakeSafeStorage()
  const vault = await makeVault(storage)
  const supervisor = makeSupervisor()
  await vault.save('fixture-credential')

  await logoutProviderCredential({ vault, core: supervisor })

  assert.deepEqual(supervisor.calls.map(({ command }) => command), ['auth.clearCredential'])
  assert.deepEqual(await vault.read(), { status: 'missing' })
})

test('restore reads the encrypted credential and rehydrates a restarted Core', async () => {
  const storage = new FakeSafeStorage()
  const vault = await makeVault(storage)
  const supervisor = makeSupervisor()
  await vault.save('fixture-credential')

  assert.equal(await restoreProviderCredential({ vault, core: supervisor }), 'configured')
  assert.deepEqual(supervisor.calls.map(({ command }) => command), [
    'auth.verifyCredential',
    'auth.setCredential',
  ])
})

test('restore marks a clearly expired credential and removes only that vault', async () => {
  const storage = new FakeSafeStorage()
  const vault = await makeVault(storage)
  const supervisor = makeSupervisor()
  supervisor.setVerification('expired')
  await vault.save('fixture-credential')

  assert.equal(await restoreProviderCredential({ vault, core: supervisor }), 'expired')
  assert.deepEqual(await vault.read(), { status: 'missing' })
  assert.deepEqual(supervisor.calls.map(({ command }) => command), ['auth.verifyCredential'])
})

test('restore keeps the vault and refuses authorization on a temporary verification failure', async () => {
  const storage = new FakeSafeStorage()
  const vault = await makeVault(storage)
  const supervisor = makeSupervisor()
  supervisor.setVerification('unavailable')
  await vault.save('fixture-credential')

  assert.equal(await restoreProviderCredential({ vault, core: supervisor }), 'unavailable')
  assert.deepEqual(await vault.read(), {
    status: 'configured',
    credential: 'fixture-credential',
  })
  assert.deepEqual(supervisor.calls.map(({ command }) => command), ['auth.verifyCredential'])
})
