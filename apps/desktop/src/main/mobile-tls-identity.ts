import { createHash, createPrivateKey, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, link, unlink, rm, type FileHandle } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { isIP } from 'node:net'
import path from 'node:path'

const IDENTITY_FILE = 'identity.json'
const FILE_MAX_BYTES = 256 * 1024
const PLAIN_MAX_BYTES = 128 * 1024
const OPENSSL = '/usr/bin/openssl'
const OPENSSL_TIMEOUT_MS = 15_000

export interface MobileSecretProtector {
  encryptString(value: string): Buffer | Promise<Buffer>
  decryptString(value: Buffer): string | Promise<string>
}
export interface MobileTlsIdentityOptions {
  directory: string
  secretProtector: MobileSecretProtector
  hosts: readonly string[]
}
export interface MobileTlsIdentity {
  serverId: string
  /** 只存在于 Main 内存；不得发给 Renderer、日志或公开 wire。 */
  authKey: Buffer
  privateKeyPEM: string
  certificatePEM: string
  certificateSha256: string
}
export class MobileTlsIdentityError extends Error {
  constructor(readonly code: 'INVALID_CONFIGURATION' | 'IDENTITY_INVALID' | 'IDENTITY_BUSY' | 'HOST_MISMATCH'
    | 'PROTECTION_UNAVAILABLE' | 'TLS_TOOL_UNAVAILABLE' | 'STORAGE_FAILED') {
    super('移动 TLS 身份当前不可用。')
    this.name = 'MobileTlsIdentityError'
  }
}

/** 首轮只接受字面 IPv4；不会将 ts.net、Funnel 或 DNS 后缀当作私有证明。 */
export function isMobilePrivateIPv4(value: unknown): value is string {
  if (typeof value !== 'string' || isIP(value) !== 4) return false
  const [a, b] = value.split('.').map(Number)
  return a === 127 || a === 10 || a === 172 && b! >= 16 && b! <= 31
    || a === 192 && b === 168 || a === 100 && b! >= 64 && b! <= 127
}
function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
function exclusiveCollision(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
function privateOwner(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid()
}
function axes(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.gid, stat.nlink, stat.mtimeMs, stat.ctimeMs].join(':')
}
async function guardedDirectory(directory: string): Promise<{ handle: FileHandle; check(): Promise<void> }> {
  const parsed = path.parse(directory)
  let current = parsed.root
  for (const component of directory.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, component)
    let observed: Stats
    try { observed = await lstat(current) }
    catch (error) {
      if (!missing(error)) throw error
      try { await mkdir(current, { mode: 0o700 }) } catch (created) { if (!exclusiveCollision(created)) throw created }
      observed = await lstat(current)
    }
    if (!observed.isDirectory() || observed.isSymbolicLink()) throw new MobileTlsIdentityError('IDENTITY_INVALID')
  }
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  try {
    const original = await handle.stat()
    const check = async () => {
      const fd = await handle.stat(), named = await lstat(directory)
      if (!fd.isDirectory() || fd.dev !== original.dev || fd.ino !== original.ino || named.dev !== fd.dev || named.ino !== fd.ino
        || named.isSymbolicLink() || (fd.mode & 0o7777) !== 0o700 || (named.mode & 0o7777) !== 0o700
        || !privateOwner(fd) || !privateOwner(named)) throw new MobileTlsIdentityError('IDENTITY_INVALID')
    }
    await check()
    return { handle, check }
  } catch (error) { await handle.close(); throw error }
}
async function privateFile<T>(file: string, maxBytes: number, consume: (bytes: Buffer) => T | Promise<T>): Promise<T> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || !privateOwner(before) || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600
      || before.size <= 0 || before.size > maxBytes) throw new MobileTlsIdentityError('IDENTITY_INVALID')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const next = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!next.bytesRead) throw new MobileTlsIdentityError('IDENTITY_INVALID')
      offset += next.bytesRead
    }
    const value = await consume(bytes)
    const after = await handle.stat(), named = await lstat(file)
    if (axes(before) !== axes(after) || axes(after) !== axes(named) || named.isSymbolicLink()) throw new MobileTlsIdentityError('IDENTITY_INVALID')
    return value
  } finally { await handle.close() }
}
async function writePrivate(file: string, bytes: Buffer | string): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.chmod(0o600); await handle.sync() }
  finally { await handle.close() }
}
function closedRecord(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === keys.length
    && keys.every(key => Object.hasOwn(raw, key))
}
function base64(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== 'string' || value.length > FILE_MAX_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new MobileTlsIdentityError('IDENTITY_INVALID')
  }
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.toString('base64') !== value || expectedBytes !== undefined && bytes.length !== expectedBytes) throw new MobileTlsIdentityError('IDENTITY_INVALID')
  return bytes
}
function identityFromPlain(raw: unknown, hosts: readonly string[]): MobileTlsIdentity {
  if (!closedRecord(raw, ['schema', 'serverId', 'authKey', 'privateKeyPEM', 'certificatePEM', 'hosts']) || raw.schema !== 1
    || typeof raw.serverId !== 'string' || !/^server:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(raw.serverId)
    || typeof raw.privateKeyPEM !== 'string' || raw.privateKeyPEM.length > 65536
    || typeof raw.certificatePEM !== 'string' || raw.certificatePEM.length > 65536
    || !Array.isArray(raw.hosts) || !raw.hosts.length || raw.hosts.length > 16
    || Array.from(raw.hosts).some(host => !isMobilePrivateIPv4(host)) || new Set(raw.hosts).size !== raw.hosts.length) {
    throw new MobileTlsIdentityError('IDENTITY_INVALID')
  }
  if (hosts.some(host => !(raw.hosts as unknown[]).includes(host))) throw new MobileTlsIdentityError('HOST_MISMATCH')
  const authKey = base64(raw.authKey, 32), certificate = new X509Certificate(raw.certificatePEM)
  if (!certificate.checkPrivateKey(createPrivateKey(raw.privateKeyPEM)) || !certificate.verify(certificate.publicKey)
    || !certificate.subject.split('\n').includes(`CN=${raw.serverId}`)
    || !Number.isFinite(Date.parse(certificate.validFrom)) || !Number.isFinite(Date.parse(certificate.validTo))
    || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()
    || (raw.hosts as string[]).some(host => !certificate.checkIP(host))) throw new MobileTlsIdentityError('IDENTITY_INVALID')
  return { serverId: raw.serverId, authKey, privateKeyPEM: raw.privateKeyPEM, certificatePEM: raw.certificatePEM,
    certificateSha256: createHash('sha256').update(certificate.raw).digest('hex') }
}
async function readIdentity(file: string, protector: MobileSecretProtector, hosts: readonly string[]): Promise<MobileTlsIdentity | null> {
  // 只有开始时真正不存在才允许新建；读途中名字消失不是 missing 身份。
  try { await lstat(file) } catch (error) { if (missing(error)) return null; throw error }
  return privateFile(file, FILE_MAX_BYTES, async bytes => {
      const envelope: unknown = JSON.parse(bytes.toString('utf8'))
      if (!closedRecord(envelope, ['schema', 'sealed']) || envelope.schema !== 1) throw new MobileTlsIdentityError('IDENTITY_INVALID')
      let plain: string
      try { plain = await protector.decryptString(base64(envelope.sealed)) }
      catch { throw new MobileTlsIdentityError('PROTECTION_UNAVAILABLE') }
      if (typeof plain !== 'string' || Buffer.byteLength(plain) > PLAIN_MAX_BYTES) throw new MobileTlsIdentityError('IDENTITY_INVALID')
      return identityFromPlain(JSON.parse(plain) as unknown, hosts)
  })
}
async function generateCertificate(directory: string, serverId: string, hosts: readonly string[]): Promise<{ privateKeyPEM: string; certificatePEM: string }> {
  try { await access(OPENSSL, constants.X_OK) }
  catch { throw new MobileTlsIdentityError('TLS_TOOL_UNAVAILABLE') }
  const temporary = await mkdtemp(path.join(directory, '.tls-create-'))
  const original = await lstat(temporary)
  try {
    const config = path.join(temporary, 'openssl.cnf'), key = path.join(temporary, 'key.pem'), certificate = path.join(temporary, 'certificate.pem')
    await writePrivate(config, `[req]\nprompt = no\ndistinguished_name = identity_name\nx509_extensions = mobile_identity\n[identity_name]\nCN = ${serverId}\n[mobile_identity]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = @identity_san\n[identity_san]\n${hosts.map((host, index) => `IP.${index + 1} = ${host}`).join('\n')}\nURI.1 = urn:musicbridge:${serverId}\n`)
    await new Promise<void>((resolve, reject) => {
      execFile(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '365',
        '-config', config, '-keyout', key, '-out', certificate], {
        cwd: temporary, env: { PATH: '/usr/bin:/bin', LANG: 'C', TMPDIR: temporary },
        timeout: OPENSSL_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 32 * 1024, windowsHide: true,
      }, error => { if (error) reject(new MobileTlsIdentityError('TLS_TOOL_UNAVAILABLE')); else resolve() })
    })
    // 工具输出也经原 FD 收紧；不通过名字 chmod 改到意外材料。
    for (const file of [key, certificate]) {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { const observed = await handle.stat(); if (!observed.isFile() || observed.nlink !== 1 || !privateOwner(observed)) throw new MobileTlsIdentityError('IDENTITY_INVALID'); await handle.chmod(0o600) }
      finally { await handle.close() }
    }
    return { privateKeyPEM: await privateFile(key, 65536, bytes => bytes.toString('utf8')),
      certificatePEM: await privateFile(certificate, 65536, bytes => bytes.toString('utf8')) }
  } finally {
    const named = await lstat(temporary)
    if (!named.isDirectory() || named.dev !== original.dev || named.ino !== original.ino) throw new MobileTlsIdentityError('IDENTITY_INVALID')
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function loadOrCreateMobileIdentity(options: MobileTlsIdentityOptions): Promise<MobileTlsIdentity> {
  if (typeof options.directory !== 'string' || !path.isAbsolute(options.directory) || options.directory !== path.resolve(options.directory)
    || options.directory === path.parse(options.directory).root || options.directory.includes('\0') || options.directory.length > 1024
    || !Array.isArray(options.hosts) || !options.hosts.length || options.hosts.length > 16
    || Array.from(options.hosts).some(host => !isMobilePrivateIPv4(host)) || new Set(options.hosts).size !== options.hosts.length
    || typeof options.secretProtector?.encryptString !== 'function' || typeof options.secretProtector?.decryptString !== 'function') {
    throw new MobileTlsIdentityError('INVALID_CONFIGURATION')
  }
  const directory = options.directory, hosts = [...options.hosts].sort(), file = path.join(directory, IDENTITY_FILE)
  const protector: MobileSecretProtector = {
    encryptString: options.secretProtector.encryptString.bind(options.secretProtector),
    decryptString: options.secretProtector.decryptString.bind(options.secretProtector),
  }
  let guarded: Awaited<ReturnType<typeof guardedDirectory>> | undefined, lock: FileHandle | undefined, temporary: string | undefined
  const lockPath = path.join(directory, '.identity-create.lock')
  try {
    guarded = await guardedDirectory(directory)
    const existing = await readIdentity(file, protector, hosts)
    await guarded.check()
    if (existing) return existing
    try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (error) { if (exclusiveCollision(error)) throw new MobileTlsIdentityError('IDENTITY_BUSY'); throw error }
    const appeared = await readIdentity(file, protector, hosts)
    if (appeared) { await guarded.check(); return appeared }
    const serverId = `server:${randomUUID()}`, authKey = randomBytes(32)
    const pem = await generateCertificate(directory, serverId, hosts)
    await guarded.check()
    const plain = JSON.stringify({ schema: 1, serverId, authKey: authKey.toString('base64'), ...pem, hosts })
    const value = identityFromPlain(JSON.parse(plain) as unknown, hosts)
    let sealed: Buffer
    try { sealed = await protector.encryptString(plain) }
    catch { throw new MobileTlsIdentityError('PROTECTION_UNAVAILABLE') }
    if (!Buffer.isBuffer(sealed) || !sealed.length || sealed.length > PLAIN_MAX_BYTES || sealed.equals(Buffer.from(plain))) throw new MobileTlsIdentityError('PROTECTION_UNAVAILABLE')
    try { if (await protector.decryptString(sealed) !== plain) throw new Error('无法回读') }
    catch { throw new MobileTlsIdentityError('PROTECTION_UNAVAILABLE') }
    const bytes = JSON.stringify({ schema: 1, sealed: sealed.toString('base64') }) + '\n'
    temporary = path.join(directory, `.identity-${randomUUID()}.tmp`)
    await guarded.check(); await writePrivate(temporary, bytes); await guarded.check()
    // 原子且不覆盖未知同名身份；硬链接发布后立即移除自有临时名字。
    await link(temporary, file); await unlink(temporary); temporary = undefined
    await guarded.handle.sync(); await guarded.check()
    const persisted = await readIdentity(file, protector, hosts)
    if (!persisted || persisted.serverId !== value.serverId || persisted.certificateSha256 !== value.certificateSha256
      || !persisted.authKey.equals(value.authKey) || persisted.privateKeyPEM !== value.privateKeyPEM) throw new MobileTlsIdentityError('IDENTITY_INVALID')
    await guarded.check()
    return value
  } catch (error) {
    if (error instanceof MobileTlsIdentityError) throw error
    throw new MobileTlsIdentityError('STORAGE_FAILED')
  } finally {
    let cleanupFailed = false
    if (temporary) await unlink(temporary).catch(error => { if (!missing(error)) cleanupFailed = true })
    if (lock) {
      try {
        const held = await lock.stat(), named = await lstat(lockPath)
        if (held.dev !== named.dev || held.ino !== named.ino || named.isSymbolicLink()) cleanupFailed = true
        else await unlink(lockPath)
      } catch { cleanupFailed = true }
      finally { await lock.close().catch(() => { cleanupFailed = true }) }
    }
    await guarded?.handle.close().catch(() => { cleanupFailed = true })
    if (cleanupFailed) throw new MobileTlsIdentityError('STORAGE_FAILED')
  }
}
