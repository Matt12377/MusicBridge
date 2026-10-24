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
import { readLibraryOperationLine } from '../../../packages/bridge-core/src/shared/library-operation-log.js'

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

test('provision keeps the encrypted credential when real Provider verification times out', async () => {
  const storage = new FakeSafeStorage()
  const vault = await makeVault(storage)
  const calls: string[] = []
  await vault.save('fixture-credential')

  const status = await provisionProviderCredential({
    vault,
    environment: {},
    core: {
      async verifyCredential(): Promise<'authorized'> {
        calls.push('auth.verifyCredential')
        throw new Error('Core request timed out')
      },
      async setCredential(): Promise<unknown> {
        calls.push('auth.setCredential')
        return undefined
      },
      async clearCredential(): Promise<unknown> {
        return undefined
      },
    },
  })

  assert.equal(status, 'unavailable')
  assert.deepEqual(calls, ['auth.verifyCredential'])
  assert.deepEqual(await vault.read(), {
    status: 'configured',
    credential: 'fixture-credential',
  })
})

test('restore keeps the encrypted credential when Core injection is temporarily unavailable', async () => {
  const storage = new FakeSafeStorage()
  const vault = await makeVault(storage)
  const calls: string[] = []
  await vault.save('fixture-credential')

  const status = await restoreProviderCredential({
    vault,
    core: {
      async verifyCredential(): Promise<'authorized'> {
        calls.push('auth.verifyCredential')
        return 'authorized'
      },
      async setCredential(): Promise<unknown> {
        calls.push('auth.setCredential')
        throw new Error('Core request timed out')
      },
      async clearCredential(): Promise<unknown> {
        return undefined
      },
    },
  })

  assert.equal(status, 'unavailable')
  assert.deepEqual(calls, ['auth.verifyCredential', 'auth.setCredential'])
  assert.deepEqual(await vault.read(), {
    status: 'configured',
    credential: 'fixture-credential',
  })
})

test('恢复诊断区分保险库不可用、Core校验和注入结果，失败不扩大凭据下发', async t => {
  const lines: string[] = []
  t.mock.method(console, 'info', (line: unknown) => { if (typeof line === 'string') lines.push(line) })
  for (const mode of ['vault-unavailable', 'authorized', 'unavailable', 'expired', 'verify-reject', 'set-reject'] as const) {
    const storage = new FakeSafeStorage(), vault = await makeVault(storage), core = makeSupervisor()
    await vault.save('diagnostic-synthetic-only')
    let verifyCalls = 0, setCalls = 0, errorReads = 0
    const failure = Object.defineProperty({}, 'message', { get() { errorReads++; return 'synthetic-private-provider-error' } })
    if (mode === 'vault-unavailable') storage.available = false
    core.verifyCredential = async () => {
      verifyCalls++
      if (mode === 'verify-reject') throw failure
      return mode === 'unavailable' || mode === 'expired' ? mode : 'authorized'
    }
    const setCredential = core.setCredential.bind(core)
    core.setCredential = async credential => { setCalls++; if (mode === 'set-reject') throw failure; return setCredential(credential) }
    lines.length = 0
    const result = await provisionProviderCredential({ vault, core, environment: {} })
    assert.equal(result, mode === 'authorized' ? 'configured' : mode === 'expired' ? 'expired' : 'unavailable', mode)
    assert.equal(verifyCalls, mode === 'vault-unavailable' ? 0 : 1)
    assert.equal(setCalls, mode === 'authorized' || mode === 'set-reject' ? 1 : 0)
    assert.equal(errorReads, 0)
    const events = lines.map(readLibraryOperationLine), stages = events.map(event => event?.action)
    assert.ok(events.every(event => event !== null && Number.isFinite(event.elapsedMs) && event.elapsedMs! >= 0))
    assert.equal(events[0]?.action, 'startup.provider-auth.migration'); assert.equal(events[0]?.code, 'NONE')
    assert.equal(stages.includes('startup.provider-auth.core-verify'), mode !== 'vault-unavailable')
    assert.equal(stages.includes('startup.provider-auth.core-set'), mode === 'authorized' || mode === 'set-reject')
    const verify = events.find(event => event?.action === 'startup.provider-auth.core-verify')
    if (verify) assert.equal(verify.code, mode === 'verify-reject' ? 'VERIFY_FAILED' : mode === 'unavailable' ? 'UNAVAILABLE' : mode === 'expired' ? 'EXPIRED' : 'AUTHORIZED')
    const serialized = lines.join('\n')
    assert.ok(!serialized.includes('diagnostic-synthetic-only') && !serialized.includes('synthetic-private-provider-error') && !serialized.includes('enc:'))
    storage.available = true
    assert.equal((await vault.read()).status, mode === 'expired' ? 'missing' : 'configured', '保留原过期删除和临时失败保留语义')
  }
})

test('恢复诊断输出故障仍只沿原校验成功路径配置Core', async t => {
  const storage = new FakeSafeStorage(), vault = await makeVault(storage), core = makeSupervisor()
  await vault.save('diagnostic-synthetic-only')
  t.mock.method(console, 'info', () => { throw new Error('受控诊断输出故障') })
  assert.equal(await restoreProviderCredential({ vault, core }), 'configured')
  assert.deepEqual(core.calls.map(call => call.command), ['auth.verifyCredential', 'auth.setCredential'])
})
