import assert from 'node:assert/strict'
import test from 'node:test'
import { createCipheriv, createDecipheriv, randomBytes, X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadOrCreateMobileIdentity, MobileTlsIdentityError, type MobileSecretProtector } from '../src/main/mobile-tls-identity.js'

function protector(): MobileSecretProtector {
  const key = randomBytes(32)
  return {
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}
async function fixture(t: test.TestContext) {
  const parent = process.platform === 'darwin' ? '/Volumes/LifeWeave/Developer/CommandLine/tmp' : path.resolve(os.tmpdir())
  const directory = await mkdtemp(path.join(parent, 'mousa-tail-tls-'))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), parent)
    assert.ok(path.basename(directory).startsWith('mousa-tail-tls-'))
    await rm(directory, { recursive: true, force: true })
  })
  const secretProtector = protector(), primaryDirectory = path.join(directory, 'primary')
  const primary = await loadOrCreateMobileIdentity({ directory: primaryDirectory, hosts: ['127.0.0.1'], secretProtector })
  const primaryBytes = await readFile(path.join(primaryDirectory, 'identity.json'))
  const auxiliary = { directory: path.join(directory, 'tailscale'), hosts: ['100.100.100.10'], secretProtector, sharedIdentity: primary }
  return { primary, primaryBytes, primaryDirectory, auxiliary }
}

test('Tailscale endpoint has exact SAN and a separate certificate without replacing primary identity or auth', async t => {
  const { primary, primaryBytes, primaryDirectory, auxiliary } = await fixture(t)
  const tail = await loadOrCreateMobileIdentity(auxiliary)
  assert.equal(tail.serverId, primary.serverId)
  assert.deepEqual(tail.authKey, primary.authKey)
  assert.notEqual(tail.certificateSha256, primary.certificateSha256)
  const cert = new X509Certificate(tail.certificatePEM)
  assert.equal(cert.checkIP(auxiliary.hosts[0]!), auxiliary.hosts[0])
  assert.equal(cert.checkIP('127.0.0.1'), undefined)
  assert.deepEqual(await readFile(path.join(primaryDirectory, 'identity.json')), primaryBytes)
  tail.authKey.fill(0)
  assert.notDeepEqual(primary.authKey, Buffer.alloc(32), 'endpoint cleanup must not zero the primary auth Buffer')
})

test('Tailscale derived identity cold-load retains its same root subject and exact leaf pin', async t => {
  const { primary, auxiliary } = await fixture(t)
  const first = await loadOrCreateMobileIdentity(auxiliary), second = await loadOrCreateMobileIdentity(auxiliary)
  assert.equal(first.serverId, primary.serverId)
  assert.equal(first.serverId, second.serverId)
  assert.equal(first.certificateSha256, second.certificateSha256)
  assert.equal(first.privateKeyPEM, second.privateKeyPEM)
  assert.deepEqual(second.authKey, primary.authKey)
  assert.equal((await lstat(path.join(auxiliary.directory, 'identity.json'))).mode & 0o777, 0o600)
})

test('Tailscale existing endpoint cannot be adopted by another root or a different auth key', async t => {
  const { primary, auxiliary } = await fixture(t)
  await loadOrCreateMobileIdentity(auxiliary)
  const file = path.join(auxiliary.directory, 'identity.json'), before = await readFile(file)
  for (const sharedIdentity of [
    { serverId: 'server:00000000-0000-4000-8000-000000000001', authKey: primary.authKey },
    { serverId: primary.serverId, authKey: randomBytes(32) },
  ]) {
    await assert.rejects(() => loadOrCreateMobileIdentity({ ...auxiliary, sharedIdentity }),
      (error: unknown) => error instanceof MobileTlsIdentityError && error.code === 'IDENTITY_INVALID')
    assert.deepEqual(await readFile(file), before)
  }
})

test('Tailscale shared identity rejects malformed root material before creating endpoint files', async t => {
  const { primary, auxiliary } = await fixture(t)
  for (const sharedIdentity of [
    { serverId: 'untrusted', authKey: primary.authKey },
    { serverId: primary.serverId, authKey: Buffer.alloc(31) },
  ]) {
    await assert.rejects(() => loadOrCreateMobileIdentity({ ...auxiliary, sharedIdentity }),
      (error: unknown) => error instanceof MobileTlsIdentityError && error.code === 'INVALID_CONFIGURATION')
    await assert.rejects(() => lstat(auxiliary.directory), { code: 'ENOENT' })
  }
})
