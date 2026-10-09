import assert from 'node:assert/strict'
import test from 'node:test'
import { createCipheriv, createDecipheriv, createHash, randomBytes, X509Certificate } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, link, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  isMobilePrivateIPv4, loadOrCreateMobileIdentity, MobileTlsIdentityError,
  type MobileSecretProtector, type MobileTlsIdentityOptions,
} from '../../src/main/mobile-tls-identity.js'

/** 受控加密 seam；证明真实文件与 TLS 身份，不冒充 Electron safeStorage 或 Owner 持久接线。 */
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
async function fixture(t: test.TestContext): Promise<MobileTlsIdentityOptions> {
  const parent = process.env.TMPDIR ?? (process.platform === 'darwin' ? '/Volumes/LifeWeave/Developer/CommandLine/tmp' : os.tmpdir())
  if (process.platform === 'darwin' && !parent.startsWith('/Volumes/LifeWeave/Developer/CommandLine/')) throw new Error('合成材料必须使用外置目录。')
  const owned = await mkdtemp(path.join(parent, 'mbm001-tls-'))
  t.after(() => rm(owned, { recursive: true, force: true }))
  return { directory: path.join(owned, 'identity'), hosts: ['127.0.0.1'], secretProtector: protector() }
}
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const failure = (code: MobileTlsIdentityError['code']) => (error: unknown) => error instanceof MobileTlsIdentityError && error.code === code

test('001 TLS加密身份冷读保持serverId、32字节authKey、证书与合法SAN，持久权限700/600', async t => {
  const options = await fixture(t); options.hosts = ['127.0.0.1', '10.18.0.1', '100.64.0.1']
  const first = await loadOrCreateMobileIdentity(options), second = await loadOrCreateMobileIdentity(options)
  assert.equal(first.serverId, second.serverId); assert.equal(first.authKey.length, 32)
  assert.equal(digest(first.authKey), digest(second.authKey)); assert.equal(first.certificateSha256, second.certificateSha256)
  assert.equal(digest(first.privateKeyPEM), digest(second.privateKeyPEM))
  const certificate = new X509Certificate(first.certificatePEM)
  for (const host of options.hosts) assert.equal(certificate.checkIP(host), host)
  assert.equal(first.certificateSha256, digest(certificate.raw)); assert.equal(certificate.subject, `CN=${first.serverId}`)
  const file = path.join(options.directory, 'identity.json'), raw = await readFile(file, 'utf8')
  assert.equal((await lstat(options.directory)).mode & 0o777, 0o700); assert.equal((await lstat(file)).mode & 0o777, 0o600)
  assert.deepEqual(Object.keys(JSON.parse(raw) as Record<string, unknown>).sort(), ['schema', 'sealed'])
  for (const secret of [first.privateKeyPEM, first.authKey.toString('base64'), first.serverId]) assert.equal(raw.includes(secret), false)
  assert.deepEqual(await readdir(options.directory), ['identity.json'])
})

test('001持久TLS身份不因新host静默再签或更换，原封存字节不动', async t => {
  const options = await fixture(t), first = await loadOrCreateMobileIdentity(options), file = path.join(options.directory, 'identity.json')
  const before = digest(await readFile(file))
  await assert.rejects(() => loadOrCreateMobileIdentity({ ...options, hosts: ['10.19.0.1'] }), failure('HOST_MISMATCH'))
  const again = await loadOrCreateMobileIdentity(options)
  assert.equal(again.serverId, first.serverId); assert.equal(again.certificateSha256, first.certificateSha256)
  assert.equal(digest(await readFile(file)), before)
})

test('001字面地址闭集拒公网、Funnel域名、wildcard、IPv6与tailnet边界外，未落身份', async t => {
  const options = await fixture(t)
  for (const host of ['8.8.8.8', '0.0.0.0', 'example.ts.net', '*.ts.net', '::1', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1']) {
    assert.equal(isMobilePrivateIPv4(host), false)
    await assert.rejects(() => loadOrCreateMobileIdentity({ ...options, hosts: [host] }), failure('INVALID_CONFIGURATION'))
  }
  for (const host of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1', '100.64.0.1', '100.127.255.254']) assert.equal(isMobilePrivateIPv4(host), true)
  await assert.rejects(() => lstat(options.directory), { code: 'ENOENT' })
})

test('001既有损坏、宽权限、硬链接与symlink身份拒绝，不当missing覆盖', async t => {
  const options = await fixture(t); await loadOrCreateMobileIdentity(options)
  const file = path.join(options.directory, 'identity.json'), original = await readFile(file)
  await writeFile(file, '{"schema":1,"sealed":"bad","foreign":true}\n'); const corrupted = digest(await readFile(file))
  await assert.rejects(() => loadOrCreateMobileIdentity(options)); assert.equal(digest(await readFile(file)), corrupted)
  await writeFile(file, original); await chmod(file, 0o644)
  await assert.rejects(() => loadOrCreateMobileIdentity(options), failure('IDENTITY_INVALID')); assert.equal((await lstat(file)).mode & 0o777, 0o644)
  await chmod(file, 0o600)
  const alias = path.join(options.directory, 'alias.json'); await link(file, alias)
  await assert.rejects(() => loadOrCreateMobileIdentity(options), failure('IDENTITY_INVALID')); assert.equal(digest(await readFile(file)), digest(original))
  await rm(alias); await rm(file); await symlink(alias, file)
  await assert.rejects(() => loadOrCreateMobileIdentity(options)); assert.equal((await lstat(file)).isSymbolicLink(), true)
})

test('001保护器不可用或plaintext返回均安全失败，临时私钥和锁收口且无fallback', async t => {
  const base = await fixture(t)
  for (const kind of ['unavailable', 'plaintext'] as const) {
    const options = { ...base, directory: path.join(path.dirname(base.directory), kind), secretProtector: {
      encryptString: (value: string) => { if (kind === 'unavailable') throw new Error('不应公开的内部错误'); return Buffer.from(value) },
      decryptString: (value: Buffer) => value.toString('utf8'),
    } }
    let caught: unknown
    try { await loadOrCreateMobileIdentity(options) } catch (error) { caught = error }
    assert.equal(failure('PROTECTION_UNAVAILABLE')(caught), true)
    assert.equal(caught instanceof Error && caught.message.includes('不应公开'), false)
    assert.deepEqual(await readdir(options.directory), [])
  }
})

test('001同目录在途新建有排他锁，第二调用不生成另一个serverId，完成后可冷读', async t => {
  const options = await fixture(t), original = options.secretProtector
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), released = new Promise<void>(resolve => { release = resolve })
  options.secretProtector = { ...original, encryptString: async value => { enter(); await released; return original.encryptString(value) } }
  const first = loadOrCreateMobileIdentity(options)
  try {
    await entered; await assert.rejects(() => loadOrCreateMobileIdentity(options), failure('IDENTITY_BUSY'))
  } finally { release() }
  const ready = await first, cold = await loadOrCreateMobileIdentity(options)
  assert.equal(ready.serverId, cold.serverId); assert.equal(ready.certificateSha256, cold.certificateSha256)
  assert.deepEqual(await readdir(options.directory), ['identity.json'])
})

test('001保护器await期间真实身份文件权限变化由同FD/名字检查拒绝，不复用旧快照', async t => {
  const options = await fixture(t); await loadOrCreateMobileIdentity(options)
  const file = path.join(options.directory, 'identity.json'), before = digest(await readFile(file)), original = options.secretProtector
  options.secretProtector = { ...original, decryptString: async value => { const result = await original.decryptString(value); await chmod(file, 0o644); return result } }
  await assert.rejects(() => loadOrCreateMobileIdentity(options), failure('IDENTITY_INVALID'))
  assert.equal(digest(await readFile(file)), before); assert.equal((await lstat(file)).mode & 0o777, 0o644)
  await chmod(file, 0o600)
})

test('001身份目录symlink或宽权限拒绝，不修改原目录和外部指向', async t => {
  const options = await fixture(t), original = path.join(path.dirname(options.directory), 'owned')
  await mkdir(original, { mode: 0o700 }); await symlink(original, options.directory)
  await assert.rejects(() => loadOrCreateMobileIdentity(options), failure('IDENTITY_INVALID'))
  assert.deepEqual(await readdir(original), []); await rm(options.directory); await mkdir(options.directory, { mode: 0o755 })
  await assert.rejects(() => loadOrCreateMobileIdentity(options), failure('IDENTITY_INVALID'))
  assert.equal((await lstat(options.directory)).mode & 0o777, 0o755)
})
