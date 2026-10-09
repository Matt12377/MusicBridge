import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import {
  decodeMobileResponse, type MobileErrorEnvelope, type MobileHeaderPairs, type MobileOperationId,
  type MobileResponseBody, type MobileTokenPair,
} from '@music-bridge/contracts'
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { checkServerIdentity, type TLSSocket } from 'node:tls'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import type { MobileConnectionSettings, MobilePublicConnection } from '../src/shared/mobile-settings.js'
import { verifiedElectronExecution } from '../scripts/electron-identity.mjs'
import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { e2eTemporaryRoot } from './temporary-root.js'
import { waitForMainWindow } from './main-window.js'

const desktop = path.resolve(import.meta.dirname, '..')
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const processes = new WeakMap<ElectronApplication, ReturnType<ElectronApplication['process']>>()
const requestMs = 20_000, responseMaxBytes = 2 * 1024 * 1024
type SafeRequestFailure = 'TLS_UNTRUSTED' | 'PIN_MISMATCH' | 'TRANSPORT_CLOSED' | 'REQUEST_TIMEOUT' | 'RESPONSE_INVALID'
class OwnedRequestError extends Error {
  constructor(readonly kind: SafeRequestFailure) { super('001自有HTTPS请求未完成：' + kind) }
}
type MainEvaluationPhase = 'PROTECTOR' | 'NATIVE_ARTWORK'
type SafeMainFailureCode = 'EVALUATION_FAILED' | 'BUILTIN_UNAVAILABLE' | 'OWNED_PROFILE_INVALID' | 'PROTECTOR_INSTALL_FAILED' | 'NATIVE_DECODE_FAILED'
class OwnedMainEvaluationError extends Error {
  constructor(readonly phase: MainEvaluationPhase, readonly code: SafeMainFailureCode) { super('001自有Main求值未完成：' + phase + '/' + code) }
}
interface HttpResult { status: number; headers: MobileHeaderPairs; body: Buffer; finalUrl: string; peerSha256: string; authorized: boolean }
interface HttpOptions { method?: 'GET' | 'POST'; accessToken?: string; idempotencyKey?: string; body?: Buffer; trust?: 'anchor-and-pin' | 'no-anchor' | 'wrong-pin' }
interface HttpObservation { label: string; operation: MobileOperationId; status: number; bytes: number; sha256: string; peerSha256: string; authorized: boolean }
interface CloseObservation { pid: number | undefined; exitCode: number | null; signal: NodeJS.Signals | null }
interface OfflineObservation { installedBeforeWindow: boolean; blockedExternalAttempts: number; blockedHostCount: number }
interface ProtectorObservation { controlled: true; encryptCalls: number; decryptCalls: number }
interface FileIdentity { fileName: string; bytes: number; sha256: string; dev: string; ino: string; mode: string; uid: string; gid: string; noFollow: true; stableNamedFd: true }

/** 本用例不录制trace/video/自动错误截图，许可与token只停留在自有进程内存。 */
test.use({ trace: 'off', video: 'off', screenshot: 'off' })
test.describe.configure({ retries: 0 })

async function launch(profile: string, pageErrors: { count: number }): Promise<ElectronApplication> {
  const identity = verifiedElectronExecution()
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(name))) as Record<string, string>
  Object.assign(env, { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_TEST_KEYCHAIN_MODE: 'mock', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profile })
  const app = await electron.launch({ executablePath: path.join(identity.packageRoot, 'dist/Electron.app/Contents/MacOS/Electron'), args: testElectronArguments([path.join(desktop, 'dist/main/index.js')], 'mock'), cwd: desktop, env })
  processes.set(app, app.process())
  const observed = new WeakSet<Page>()
  const observe = (page: Page) => { if (!observed.has(page)) { observed.add(page); page.on('pageerror', () => { pageErrors.count++ }) } }
  app.on('window', observe); for (const page of app.windows()) observe(page)
  return app
}
async function closeNormally(app: ElectronApplication, closes: CloseObservation[]): Promise<void> {
  const child = processes.get(app); if (!child) throw new Error('001未捕获原App子进程。')
  const closed = child.exitCode === null && child.signalCode === null
    ? new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })))
    : Promise.resolve({ exitCode: child.exitCode, signal: child.signalCode })
  await app.close(); const result = await closed
  closes.push({ pid: child.pid, ...result }); expect(result).toEqual({ exitCode: 0, signal: null })
}
async function auditOffline(app: ElectronApplication, observations: OfflineObservation[]): Promise<void> {
  const value = await app.evaluate(() => (globalThis as typeof globalThis & { __musicBridgeUiE2eNetworkEvidence?: { installedBeforeWindow: boolean; blockedExternalAttempts: number; blockedHosts: string[] } }).__musicBridgeUiE2eNetworkEvidence)
  expect(value?.installedBeforeWindow).toBe(true); expect(value?.blockedExternalAttempts).toBe(0); expect(value?.blockedHosts.length).toBe(0)
  if (!value) throw new Error('001实际离线guard证据缺失。')
  observations.push({ installedBeforeWindow: value.installedBeforeWindow, blockedExternalAttempts: value.blockedExternalAttempts, blockedHostCount: value.blockedHosts.length })
}

/** 仅替换自有Main的三项safeStorage方法；真实TLS、鉴权、CoreSupervisor及唯一Owner不替换。 */
async function controlProtector(app: ElectronApplication, key: Buffer): Promise<void> {
  // Main求值通过Inspector执行，使用真实builtin而不依赖动态import回调。
  const result = await app.evaluate(({ safeStorage }, keyHex) => {
    let code: 'BUILTIN_UNAVAILABLE' | 'OWNED_PROFILE_INVALID' | 'PROTECTOR_INSTALL_FAILED' = 'BUILTIN_UNAVAILABLE'
    try {
      if (typeof process.getBuiltinModule !== 'function') return { ok: false as const, code }
      const builtin = process.getBuiltinModule('node:crypto')
      if (!builtin || typeof builtin.createCipheriv !== 'function' || typeof builtin.createDecipheriv !== 'function' || typeof builtin.randomBytes !== 'function') return { ok: false as const, code }
      const { createCipheriv, createDecipheriv, randomBytes } = builtin
      code = 'OWNED_PROFILE_INVALID'
      const ownedKey = Buffer.from(keyHex, 'hex')
      if (ownedKey.length !== 32 || process.env.MUSIC_BRIDGE_UI_E2E_OFFLINE !== '1' || !process.env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR?.includes('musicbridge-ui-e2e-')) return { ok: false as const, code }
      code = 'PROTECTOR_INSTALL_FAILED'
      const state = globalThis as typeof globalThis & { __ownedMobileProtector: { encryptCalls: number; decryptCalls: number } }
      state.__ownedMobileProtector = { encryptCalls: 0, decryptCalls: 0 }
      safeStorage.isEncryptionAvailable = () => true
      safeStorage.encryptString = value => {
        state.__ownedMobileProtector.encryptCalls++
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', ownedKey, iv)
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
      }
      safeStorage.decryptString = value => {
        if (!Buffer.isBuffer(value) || value.length < 29) throw new Error('001受控密文无效。')
        state.__ownedMobileProtector.decryptCalls++
        const decipher = createDecipheriv('aes-256-gcm', ownedKey, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28))
        return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
      }
      return { ok: true as const }
    } catch { return { ok: false as const, code } }
  }, key.toString('hex')).catch(() => { throw new OwnedMainEvaluationError('PROTECTOR', 'EVALUATION_FAILED') })
  if (!result.ok) throw new OwnedMainEvaluationError('PROTECTOR', result.code)
}
async function protectorFacts(app: ElectronApplication): Promise<ProtectorObservation> {
  const value = await app.evaluate(() => (globalThis as typeof globalThis & { __ownedMobileProtector?: { encryptCalls: number; decryptCalls: number } }).__ownedMobileProtector)
  if (!value || !Number.isSafeInteger(value.encryptCalls) || !Number.isSafeInteger(value.decryptCalls)) throw new Error('001受控protector计数缺失。')
  return { controlled: true, ...value }
}
async function ownPort(): Promise<number> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string' || address.port < 1024 || address.port > 65535) throw new Error('001自有监听端口无效。')
    return address.port
  } finally { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
async function settings(page: Page): Promise<MobileConnectionSettings> {
  return page.evaluate(async () => {
    if (!window.musicBridgeMobile) throw new Error('001可信设置叶API缺失。')
    return window.musicBridgeMobile.getMobileConnectionSettings()
  })
}
async function mobilePanel(page: Page): Promise<Locator> {
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime, { timeout: 20_000 }).toBe('ready')
  await page.getByRole('button', { name: '打开设置', exact: true }).click()
  await page.getByRole('tab', { name: '应用', exact: true }).click()
  const panel = page.locator('[data-mobile-connection-settings]'); await expect(panel).toBeVisible()
  await expect(panel.locator('.settings-status-pill')).toHaveText('已关闭')
  return panel
}
async function enable(page: Page, panel: Locator, port: number): Promise<MobilePublicConnection> {
  await panel.getByLabel('移动连接地址', { exact: true }).selectOption('127.0.0.1')
  await panel.getByLabel('移动连接端口', { exact: true }).fill(String(port))
  await panel.getByRole('button', { name: '开启移动连接', exact: true }).click()
  await expect(panel.locator('.settings-status-pill')).toHaveText('可配对', { timeout: 20_000 })
  const current = await settings(page)
  expect(current.enabled).toBe(true); expect(current.state).toBe('ready'); expect(current.host).toBe('127.0.0.1'); expect(current.port).toBe(port)
  if (!current.connection) throw new Error('001真实开启未提供连接资料。')
  const connection = current.connection
  expect(Object.keys(connection).sort()).toEqual(['baseURL', 'certificatePEM', 'certificateSha256', 'schemaVersion', 'serverId'])
  expect(connection.schemaVersion).toBe(1); expect(connection.baseURL).toBe('https://127.0.0.1:' + port)
  const certificate = new X509Certificate(connection.certificatePEM)
  expect(sha(certificate.raw)).toBe(connection.certificateSha256); expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1')
  expect(certificate.subject.split('\n').includes('CN=' + connection.serverId)).toBe(true)
  expect(certificate.verify(certificate.publicKey)).toBe(true); expect(Date.parse(certificate.validTo) > Date.now()).toBe(true)
  await panel.locator('summary').click()
  const text = await panel.getByLabel('移动连接公开资料', { exact: true }).inputValue()
  expect(JSON.parse(text)).toEqual(connection)
  return connection
}
async function disable(page: Page, panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: '关闭移动连接', exact: true }).click()
  await expect(panel.locator('.settings-status-pill')).toHaveText('已关闭', { timeout: 20_000 })
  const current = await settings(page); expect(current.enabled).toBe(false); expect(current.state).toBe('off'); expect(current.connection).toBeNull()
}
async function permit(page: Page, panel: Locator): Promise<{ secret: string; panel: Locator }> {
  await panel.getByRole('button', { name: '生成配对许可', exact: true }).click()
  const input = panel.getByLabel('本次配对许可', { exact: true }); await expect(input).toBeVisible()
  const secret = await input.inputValue(); expect(secret.length >= 16).toBe(true)
  // 真实切换设置分类使许可组件卸载；后续截图没有许可输入，不改DOM或Vue状态。
  await page.getByRole('tab', { name: '播放', exact: true }).click(); await expect(page.locator('[data-mobile-connection-settings]')).toHaveCount(0)
  await page.getByRole('tab', { name: '应用', exact: true }).click()
  const replacement = page.locator('[data-mobile-connection-settings]'); await expect(replacement.locator('.settings-status-pill')).toHaveText('可配对')
  await expect(replacement.locator('.mobile-pairing-permit')).toHaveCount(0)
  return { secret, panel: replacement }
}
async function safeScreenshot(page: Page, directory: string, fileName: string): Promise<FileIdentity> {
  await expect(page.locator('.mobile-pairing-permit')).toHaveCount(0)
  await page.screenshot({ path: path.join(directory, fileName), fullPage: true, mask: [page.locator('.mobile-pairing-permit')] })
  const handle = await open(path.join(directory, fileName), constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.chmod(0o600) } finally { await handle.close() }
  return fileIdentity(path.join(directory, fileName), fileName)
}

/** 独立HTTPS client：正常CA/hostname校验在前，证书DER pin在后；不关闭TLS校验、不跟随redirect。 */
function readHttps(connection: MobilePublicConnection, target: string, options: HttpOptions = {}): Promise<HttpResult> {
  const base = new URL(connection.baseURL), final = new URL(target, base)
  if (base.protocol !== 'https:' || base.hostname !== '127.0.0.1' || base.username || base.password || base.pathname !== '/' || base.search || base.hash
    || final.origin !== base.origin || final.hash || final.username || final.password) return Promise.reject(new OwnedRequestError('RESPONSE_INVALID'))
  const trust = options.trust ?? 'anchor-and-pin', body = options.body, headers = ['Host', base.host, 'Connection', 'close']
  if (options.accessToken !== undefined) headers.push('Authorization', 'Bearer ' + options.accessToken)
  if (options.idempotencyKey !== undefined) headers.push('Idempotency-Key', options.idempotencyKey)
  if (body !== undefined) headers.push('Content-Type', 'application/json', 'Content-Length', String(body.length))
  return new Promise<HttpResult>((resolve, reject) => {
    let finished = false
    const failure = (kind: SafeRequestFailure) => { if (!finished) { finished = true; clearTimeout(deadline); reject(new OwnedRequestError(kind)) } }
    const request = httpsRequest({ hostname: base.hostname, port: base.port, path: final.pathname + final.search, method: options.method ?? 'GET', headers, agent: false, rejectUnauthorized: true,
      ...(trust === 'no-anchor' ? {} : { ca: connection.certificatePEM }),
      checkServerIdentity(host, certificate) {
        const ordinary = checkServerIdentity(host, certificate); if (ordinary) return ordinary
        if (!certificate.raw || sha(certificate.raw) !== (trust === 'wrong-pin' ? '0'.repeat(64) : connection.certificateSha256)) {
          const error = new Error('001证书pin不符。') as NodeJS.ErrnoException; error.code = 'ERR_001_PIN_MISMATCH'; return error
        }
        return undefined
      },
    }, response => {
      const socket = response.socket as TLSSocket, certificate = socket.getPeerCertificate(), peerSha256 = certificate.raw ? sha(certificate.raw) : ''
      if (!socket.authorized || peerSha256 !== connection.certificateSha256 || response.statusCode === undefined) { response.destroy(); request.destroy(); failure('RESPONSE_INVALID'); return }
      const chunks: Buffer[] = []; let bytes = 0
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > responseMaxBytes) { response.destroy(); request.destroy(); failure('RESPONSE_INVALID') } else chunks.push(Buffer.from(chunk)) })
      response.once('error', () => failure('TRANSPORT_CLOSED')); response.once('aborted', () => failure('TRANSPORT_CLOSED'))
      response.once('end', () => {
        if (finished) return
        const pairs: [string, string][] = []
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index], value = response.rawHeaders[index + 1]
          if (name === undefined || value === undefined) { failure('RESPONSE_INVALID'); return }
          pairs.push([name, value])
        }
        finished = true; clearTimeout(deadline)
        resolve({ status: response.statusCode!, headers: pairs, body: Buffer.concat(chunks), finalUrl: final.href, peerSha256, authorized: socket.authorized })
      })
    })
    const deadline = setTimeout(() => { request.destroy(); failure('REQUEST_TIMEOUT') }, requestMs)
    request.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      failure(code === 'ERR_001_PIN_MISMATCH' ? 'PIN_MISMATCH' : ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code ?? '') ? 'TLS_UNTRUSTED' : 'TRANSPORT_CLOSED')
    })
    request.end(body)
  })
}
async function expectedTransportFailure(connection: MobilePublicConnection, trust: HttpOptions['trust'], kind: SafeRequestFailure): Promise<void> {
  let failure: SafeRequestFailure | null = null
  try { await readHttps(connection, '/mobile/v1/server', trust === undefined ? {} : { trust }) }
  catch (error) { if (error instanceof OwnedRequestError) failure = error.kind; else throw new Error('001独立TLS client出现未分类错误。') }
  expect(failure).toBe(kind)
}
async function wholeReply<O extends MobileOperationId>(connection: MobilePublicConnection, operation: O, target: string, label: string, observations: HttpObservation[], expectedStatus: number, options: HttpOptions = {}): Promise<{ body: MobileResponseBody<O> | MobileErrorEnvelope; sha256: string }> {
  const actual = await readHttps(connection, target, options), bodySha256 = sha(actual.body)
  observations.push({ label, operation, status: actual.status, bytes: actual.body.length, sha256: bodySha256, peerSha256: actual.peerSha256, authorized: actual.authorized })
  expect(actual.status).toBe(expectedStatus)
  const decoded = decodeMobileResponse(operation, { status: actual.status, headers: actual.headers, body: new Uint8Array(actual.body), finalUrl: actual.finalUrl }, { responseOrigin: connection.baseURL, requestPath: new URL(actual.finalUrl).pathname })
  expect(decoded.ok).toBe(true)
  if (!decoded.ok) throw new Error('001完整wire回包未获校验。')
  expect(decoded.value.category).toBe(expectedStatus >= 400 ? 'error' : expectedStatus === 204 ? 'empty' : 'success')
  return { body: decoded.value.body, sha256: bodySha256 }
}
async function jsonSuccess<O extends MobileOperationId>(connection: MobilePublicConnection, operation: O, target: string, label: string, observations: HttpObservation[], expectedStatus: number, options: HttpOptions = {}): Promise<{ body: MobileResponseBody<O>; sha256: string }> {
  const reply = await wholeReply(connection, operation, target, label, observations, expectedStatus, options)
  if (expectedStatus >= 400) throw new Error('001成功回包不可选错误状态。')
  return { body: reply.body as MobileResponseBody<O>, sha256: reply.sha256 }
}
async function denied(connection: MobilePublicConnection, accessToken: string, label: string, observations: HttpObservation[]): Promise<void> {
  const result = await wholeReply(connection, 'getCapabilities', '/mobile/v1/capabilities', label, observations, 401, { accessToken })
  expect((result.body as MobileErrorEnvelope).error.code).toBe('UNAUTHORIZED')
}

/** 自然关闭后的私有文件只读全FD：不将密文或token body写进收据。 */
async function fileIdentity(file: string, fileName: string, privateMode = true): Promise<FileIdentity> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true }); expect(before.isFile()).toBe(true); expect(before.nlink).toBe(1n)
    expect(before.size > 0n && before.size <= 8n * 1024n * 1024n).toBe(true)
    if (privateMode) expect(before.mode & 0o7777n).toBe(0o600n)
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true })
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'] as const) { expect(after[key]).toBe(before[key]); expect(named[key]).toBe(before[key]) }
    expect(BigInt(bytes.length)).toBe(before.size)
    return { fileName, bytes: bytes.length, sha256: sha(bytes), dev: String(before.dev), ino: String(before.ino), mode: String(before.mode & 0o7777n), uid: String(before.uid), gid: String(before.gid), noFollow: true, stableNamedFd: true }
  } finally { await handle.close() }
}
async function closedOwnedState(profile: string, expectedCounts: { assets: number; tracks: number; sourceBindings?: number } = { assets: 0, tracks: 0, sourceBindings: 0 }) {
  const identity = await fileIdentity(path.join(profile, 'mobile-connection/identity/identity.json'), 'mobile-connection/identity/identity.json')
  const sealed = await fileIdentity(path.join(profile, 'data/mobile-devices/device-state.v1.sealed.json'), 'data/mobile-devices/device-state.v1.sealed.json')
  const file = path.join(profile, 'data/collection.v1.sqlite')
  for (const suffix of ['-wal', '-shm']) await expect(lstat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' })
  const before = await fileIdentity(file, 'data/collection.v1.sqlite', false), uri = pathToFileURL(file); uri.search = '?mode=ro&immutable=1'
  const db = new DatabaseSync(':memory:', { allowExtension: false })
  let counts: { assets: number; tracks: number; sourceBindings: number }
  try {
    db.prepare('ATTACH DATABASE ? AS owned').run(uri.href)
    const count = (table: 'local_catalog_assets' | 'local_catalog_tracks' | 'source_bindings') => Number(db.prepare('SELECT COUNT(*) AS total FROM owned.' + table).get()?.total)
    counts = { assets: count('local_catalog_assets'), tracks: count('local_catalog_tracks'), sourceBindings: count('source_bindings') }
    expect(counts.assets).toBe(expectedCounts.assets); expect(counts.tracks).toBe(expectedCounts.tracks)
    expect(Number.isSafeInteger(counts.sourceBindings) && counts.sourceBindings >= 0).toBe(true)
    if (expectedCounts.sourceBindings !== undefined) expect(counts.sourceBindings).toBe(expectedCounts.sourceBindings)
  } finally { db.close(); expect(await fileIdentity(file, 'data/collection.v1.sqlite', false)).toEqual(before) }
  for (const suffix of ['-wal', '-shm']) await expect(lstat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' })
  return { identity, sealedState: sealed, closedDatabase: before, catalogCounts: counts, readOnlyImmutable: true, emptyCatalogOnly: expectedCounts.assets === 0 && expectedCounts.tracks === 0, nonEmptySourceBindingHistoryVerified: false }
}

/** 001自己生成的有效PCM/WAVE与两张完整PNG；不复制旧App、账号、fixture或网络图片。 */
function ownedWave(): Buffer {
  const sampleRate = 44100, samples = 8820, pcm = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index++) pcm.writeInt16LE(Math.round(3200 * Math.sin(2 * Math.PI * 440 * index / sampleRate)), index * 2)
  const chunk = (id: string, bytes: Buffer) => {
    const header = Buffer.alloc(8); header.write(id, 0, 4, 'ascii'); header.writeUInt32LE(bytes.length, 4)
    return Buffer.concat([header, bytes, bytes.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const format = Buffer.alloc(16); format.writeUInt16LE(1, 0); format.writeUInt16LE(1, 2); format.writeUInt32LE(sampleRate, 4)
  format.writeUInt32LE(sampleRate * 2, 8); format.writeUInt16LE(2, 12); format.writeUInt16LE(16, 14)
  const info = Buffer.concat([Buffer.from('INFO'), chunk('INAM', Buffer.from('001 owned artwork track\0')), chunk('IART', Buffer.from('MusicBridge synthetic author\0'))])
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', format), chunk('LIST', info), chunk('data', pcm)])
  const header = Buffer.alloc(8); header.write('RIFF', 0, 4, 'ascii'); header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}
function ownedPng(variant: 0 | 1): Buffer {
  const width = 640, height = 320, pixels = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 4 + 1) + 1 + x * 4
      pixels[offset] = variant === 0 ? 40 + x % 170 : 210 - y % 150
      pixels[offset + 1] = variant === 0 ? 160 - y % 110 : 30 + x % 190
      pixels[offset + 2] = variant === 0 ? 190 : 60; pixels[offset + 3] = 255
    }
  }
  const chunk = (name: string, bytes: Buffer) => {
    const payload = Buffer.concat([Buffer.from(name, 'ascii'), bytes]); let crc = 0xffffffff
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1 }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, payload, checksum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
async function ownDirectoryPicker(app: ElectronApplication, directory: string): Promise<void> {
  await app.evaluate(({ dialog }, directory) => {
    const state = globalThis as typeof globalThis & { __ownedMobilePickerCalls: number; __ownedMobilePickerResult?: Promise<{ canceled: boolean; filePaths: string[] }> }
    state.__ownedMobilePickerCalls = 0
    dialog.showOpenDialog = ((...args: unknown[]) => {
      const options = args.at(-1) as { properties?: string[] }
      if (!options.properties?.includes('openDirectory')) throw new Error('001只控制自有扫描目录选择。')
      state.__ownedMobilePickerCalls++
      state.__ownedMobilePickerResult = Promise.resolve({ canceled: false, filePaths: [directory] })
      return state.__ownedMobilePickerResult
    }) as typeof dialog.showOpenDialog
  }, directory)
}
async function importAndSelectOwnedPng(page: Page, trackId: string, editionId: string, bytes: Buffer) {
  return page.evaluate(async ({ trackId, editionId, bytes, expectedHash }) => {
    const current = await window.musicBridge.getLocalArtworkContext({ trackId, editionId })
    if (!current.target) throw new Error('001真实发行封面target缺失。')
    const staged = await window.musicBridge.importLocalArtworkBytes({ target: current.target, bytes: new Uint8Array(bytes) })
    if (!staged.target) throw new Error('001完整PNG未形成真实候选。')
    const candidate = staged.candidates.find(value => value.origin === 'manual' && value.original.sha256 === expectedHash)
    if (!candidate) throw new Error('001自有PNG候选未找到，不使用默认或远程图片。')
    return window.musicBridge.applyLocalArtworkSelection({ commandId: crypto.randomUUID(), target: staged.target, candidateId: candidate.id, expectedSelectionRevision: staged.selection?.revision ?? null })
  }, { trackId, editionId, bytes: Array.from(bytes), expectedHash: sha(bytes) })
}
async function nativeArtwork(app: ElectronApplication, connection: MobilePublicConnection, artworkId: string, accessToken: string, size: 96 | 256 | 512, directory: string, label: string, http: HttpObservation[]) {
  const result = await readHttps(connection, '/mobile/v1/artwork/' + artworkId + '?size=' + size, { accessToken })
  const bodySha256 = sha(result.body)
  http.push({ label, operation: 'getArtwork', status: result.status, bytes: result.body.length, sha256: bodySha256, peerSha256: result.peerSha256, authorized: result.authorized })
  expect(result.status).toBe(200); expect(result.body.length > 4 && result.body.length <= responseMaxBytes).toBe(true)
  const decoded = decodeMobileResponse('getArtwork', { status: result.status, headers: result.headers, body: new Uint8Array(result.body), finalUrl: result.finalUrl }, { responseOrigin: connection.baseURL, requestPath: new URL(result.finalUrl).pathname })
  expect(decoded.ok).toBe(true); if (!decoded.ok) throw new Error('001完整封面wire元数据未获校验。')
  expect(decoded.value.category).toBe('binary')
  expect(result.body.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true); expect(result.body.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true)
  const evaluated = await app.evaluate(({ nativeImage }, base64) => {
    let code: 'BUILTIN_UNAVAILABLE' | 'NATIVE_DECODE_FAILED' = 'BUILTIN_UNAVAILABLE'
    try {
      if (typeof process.getBuiltinModule !== 'function') return { ok: false as const, code }
      const builtin = process.getBuiltinModule('node:crypto')
      if (!builtin || typeof builtin.createHash !== 'function') return { ok: false as const, code }
      code = 'NATIVE_DECODE_FAILED'
      const { createHash } = builtin, bytes = Buffer.from(base64, 'base64'), image = nativeImage.createFromBuffer(bytes)
      const { width, height } = image.getSize(), bitmap = image.toBitmap()
      return { ok: true as const, image: { empty: image.isEmpty(), width, height, jpegBytes: bytes.length, jpegSha256: createHash('sha256').update(bytes).digest('hex'), bitmapBytes: bitmap.length, bitmapSha256: createHash('sha256').update(bitmap).digest('hex') } }
    } catch { return { ok: false as const, code } }
  }, result.body.toString('base64')).catch(() => { throw new OwnedMainEvaluationError('NATIVE_ARTWORK', 'EVALUATION_FAILED') })
  if (!evaluated.ok) throw new OwnedMainEvaluationError('NATIVE_ARTWORK', evaluated.code)
  const image = evaluated.image
  expect(image.empty).toBe(false); expect(image.width).toBe(size); expect(image.height).toBe(size / 2)
  expect(image.jpegBytes).toBe(result.body.length); expect(image.jpegSha256).toBe(bodySha256); expect(image.bitmapBytes).toBe(size * (size / 2) * 4)
  const fileName = label + '-' + size + '.jpeg'; await writeFile(path.join(directory, fileName), result.body, { flag: 'wx', mode: 0o600 })
  const material = await fileIdentity(path.join(directory, fileName), fileName); expect(material.sha256).toBe(bodySha256)
  return { size, artworkId, ...image, material, actualAppNativeImageDecode: true }
}

test('001生产Main/HTTPS/唯一Owner真实UI启停、配对与原回执、刷新撤销和冷重开', async () => {
  test.setTimeout(240_000)
  const directory = await mkdtemp(path.join(e2eTemporaryRoot(), 'mbm001-mobile-connection-'))
  const profile = path.join(directory, 'musicbridge-ui-e2e-' + path.basename(directory)); await mkdir(profile, { mode: 0o700 })
  const protectorKey = randomBytes(32), port = await ownPort(), pageErrors = { count: 0 }
  const closes: CloseObservation[] = [], offline: OfflineObservation[] = [], protectors: ProtectorObservation[] = [], http: HttpObservation[] = [], screenshots: FileIdentity[] = [], ownedStates: Awaited<ReturnType<typeof closedOwnedState>>[] = []
  const facts: Record<string, unknown> = { synthetic: true, productionDist: true, controlledProtector: true, actualKeychain: 'NOT_RUN', emptyCatalogOnly: true, multiPageCatalog: 'NOT_RUN', positiveArtwork: 'NOT_RUN', realProvider: 'NOT_RUN', realRoon: 'NOT_RUN', devicePlayback: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' }
  let app: ElectronApplication | undefined, completed = false, stage = '首次启动', failureKind: string | null = null
  let mainFailure: { phase: MainEvaluationPhase; code: SafeMainFailureCode } | null = null
  try {
    app = await launch(profile, pageErrors); let page = await waitForMainWindow(app)
    await controlProtector(app, protectorKey); let panel = await mobilePanel(page)
    const defaultOff = await settings(page); expect(defaultOff.enabled).toBe(false); expect(defaultOff.state).toBe('off'); expect(defaultOff.connection).toBeNull(); expect(defaultOff.devices).toEqual([])
    expect(await page.evaluate(() => Object.keys(window.musicBridgeMobile ?? {}).sort())).toEqual(['configureMobileConnection', 'getMobileConnectionSettings', 'issueMobilePairing', 'revokeMobileDevice'])
    expect(await page.evaluate(async () => (await window.musicBridge.queryLocalLibraryTracks({ query: '', rootId: null, offset: 0, limit: 100 })).total)).toBe(0)
    const datasetId = await page.evaluate(async () => (await window.musicBridge.getCommandOutbox()).datasetId)
    facts.datasetId = datasetId; facts.defaultOff = true
    screenshots.push(await safeScreenshot(page, directory, '01-default-off.png'))

    stage = '真实UI开启与TLS校验'
    let connection = await enable(page, panel, port); const originalConnection = { ...connection }; facts.connection = originalConnection
    await expectedTransportFailure(connection, 'no-anchor', 'TLS_UNTRUSTED'); await expectedTransportFailure(connection, 'wrong-pin', 'PIN_MISMATCH')
    const server = await jsonSuccess(connection, 'getServer', '/mobile/v1/server', 'server-whole-body', http, 200)
    expect(server.body.serverId).toBe(connection.serverId); expect(server.body.contractVersion).toBe('0.1.0'); expect(server.body.environment).toBe('production')
    facts.tls = { noAnchorRejected: true, incorrectPinRejected: true, normalCaAndHostnameValidation: true, actualPeerDerSha256: connection.certificateSha256, independentHttpsClient: true }
    screenshots.push(await safeScreenshot(page, directory, '02-ready-public-connection.png'))
    const unauthenticated = await wholeReply(connection, 'getCapabilities', '/mobile/v1/capabilities', 'missing-auth', http, 401)
    expect((unauthenticated.body as MobileErrorEnvelope).error.code).toBe('UNAUTHORIZED')

    stage = '真实UI许可与成对原回执'
    const permissionA = await permit(page, panel); panel = permissionA.panel
    const claimA = Buffer.from(JSON.stringify({ pairingSecret: permissionA.secret, installationId: randomUUID(), deviceName: '001合成客户端A' })), claimKeyA = randomUUID()
    const pairA = await jsonSuccess(connection, 'claimPairing', '/mobile/v1/pairings/claim', 'pair-A', http, 201, { method: 'POST', idempotencyKey: claimKeyA, body: claimA })
    let tokensA: MobileTokenPair = pairA.body
    expect(tokensA.serverId).toBe(connection.serverId)
    const sameClaim = await jsonSuccess(connection, 'claimPairing', '/mobile/v1/pairings/claim', 'pair-A-original-receipt', http, 201, { method: 'POST', idempotencyKey: claimKeyA, body: claimA })
    expect(sameClaim.sha256).toBe(pairA.sha256)
    const changedClaim = Buffer.from(JSON.stringify({ ...JSON.parse(claimA.toString('utf8')), deviceName: '001冲突名称' }))
    const conflict = await wholeReply(connection, 'claimPairing', '/mobile/v1/pairings/claim', 'pair-A-same-key-different-body', http, 409, { method: 'POST', idempotencyKey: claimKeyA, body: changedClaim })
    expect((conflict.body as MobileErrorEnvelope).error.code).toBe('IDEMPOTENCY_CONFLICT')
    const permissionB = await permit(page, panel); panel = permissionB.panel
    const claimB = Buffer.from(JSON.stringify({ pairingSecret: permissionB.secret, installationId: randomUUID(), deviceName: '001合成客户端B' }))
    const pairB = await jsonSuccess(connection, 'claimPairing', '/mobile/v1/pairings/claim', 'pair-B', http, 201, { method: 'POST', idempotencyKey: randomUUID(), body: claimB }), tokensB = pairB.body
    expect(tokensB.deviceId === tokensA.deviceId).toBe(false); expect(tokensB.serverId).toBe(connection.serverId)
    facts.devices = { deviceA: tokensA.deviceId, deviceB: tokensB.deviceId, distinct: true }; facts.originalClaimReceiptWholeBodyEqual = true

    stage = '有鉴权空目录与闭集能力'
    const capability = await jsonSuccess(connection, 'getCapabilities', '/mobile/v1/capabilities', 'capabilities-A', http, 200, { accessToken: tokensA.accessToken })
    expect(capability.body).toEqual({ contractVersion: '0.1.0', localPlayback: true, neteasePlayback: false, transcoding: false, hls: false, preparedVariants: false, qualityProfiles: ['auto', 'lossless'], maxConcurrentSessions: 2 })
    const albums = await jsonSuccess(connection, 'listAlbums', '/mobile/v1/albums?limit=100', 'empty-albums-source-omitted-is-local', http, 200, { accessToken: tokensA.accessToken })
    const tracks = await jsonSuccess(connection, 'listTracks', '/mobile/v1/tracks?source=local&limit=100', 'empty-tracks-explicit-local', http, 200, { accessToken: tokensA.accessToken })
    expect(albums.body.items).toEqual([]); expect(albums.body.nextCursor).toBeNull(); expect(tracks.body.items).toEqual([]); expect(tracks.body.nextCursor).toBeNull()
    expect(albums.body.libraryRevision).toBe(tracks.body.libraryRevision)
    for (const source of ['all', 'netease'] as const) {
      const unavailable = await wholeReply(connection, 'listAlbums', '/mobile/v1/albums?source=' + source, 'unsupported-source-' + source, http, 503, { accessToken: tokensA.accessToken })
      expect((unavailable.body as MobileErrorEnvelope).error.code).toBe('BUSY')
    }
    const missing = { album: `la:${datasetId}:${randomUUID()}`, track: `lt:${datasetId}:${randomUUID()}:${randomUUID()}`, artwork: `aw:${datasetId}:${randomUUID()}:1` }
    for (const row of [{ operation: 'getAlbum', target: '/mobile/v1/albums/' + missing.album }, { operation: 'getTrack', target: '/mobile/v1/tracks/' + missing.track }, { operation: 'getArtwork', target: '/mobile/v1/artwork/' + missing.artwork + '?size=96' }] as const) {
      const absent = await wholeReply(connection, row.operation, row.target, 'owned-empty-missing-' + row.operation, http, 404, { accessToken: tokensA.accessToken })
      expect((absent.body as MobileErrorEnvelope).error.code).toBe('INVALID_REQUEST')
    }
    facts.catalog = { emptyAlbums: 0, emptyTracks: 0, nextCursor: null, libraryRevision: albums.body.libraryRevision, sourceOmittedLocal: true, explicitUnsupportedSourcesRejected: true, missingDetailsAndArtworkRejected: true, nonEmptyPageOrCursorChainVerified: false }

    stage = '刷新轮换与原回执'
    const oldTokensA = tokensA, refreshBody = Buffer.from(JSON.stringify({ refreshToken: oldTokensA.refreshToken })), refreshKey = randomUUID()
    const refreshed = await jsonSuccess(connection, 'refreshToken', '/mobile/v1/auth/refresh', 'refresh-A', http, 200, { method: 'POST', idempotencyKey: refreshKey, body: refreshBody }); tokensA = refreshed.body
    expect(tokensA.serverId).toBe(connection.serverId); expect(tokensA.deviceId).toBe(oldTokensA.deviceId)
    expect(tokensA.accessToken === oldTokensA.accessToken).toBe(false); expect(tokensA.refreshToken === oldTokensA.refreshToken).toBe(false)
    const sameRefresh = await jsonSuccess(connection, 'refreshToken', '/mobile/v1/auth/refresh', 'refresh-A-original-receipt', http, 200, { method: 'POST', idempotencyKey: refreshKey, body: refreshBody })
    expect(sameRefresh.sha256).toBe(refreshed.sha256)
    await denied(connection, oldTokensA.accessToken, 'old-access-after-refresh', http)
    await wholeReply(connection, 'refreshToken', '/mobile/v1/auth/refresh', 'old-refresh-new-key-rejected', http, 401, { method: 'POST', idempotencyKey: randomUUID(), body: refreshBody })
    await jsonSuccess(connection, 'getCapabilities', '/mobile/v1/capabilities', 'new-access-after-refresh', http, 200, { accessToken: tokensA.accessToken })
    await panel.getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect(panel.locator('.mobile-paired-devices li')).toHaveCount(2)
    const paired = await settings(page); expect(paired.devices.map(device => device.deviceId).sort()).toEqual([tokensA.deviceId, tokensB.deviceId].sort()); expect(paired.devices.every(device => !device.revoked)).toBe(true)
    facts.refreshed = { sameDevice: true, bothTokensRotated: true, oldAccessRejected: true, oldRefreshNewKeyRejected: true, originalReceiptWholeBodyEqual: true }
    screenshots.push(await safeScreenshot(page, directory, '03-paired-no-permit.png'))

    stage = '真实UI关闭与同身份重新开启'
    await disable(page, panel); await expectedTransportFailure(connection, undefined, 'TRANSPORT_CLOSED')
    connection = await enable(page, panel, port); expect(connection).toEqual(originalConnection)
    await jsonSuccess(connection, 'getCapabilities', '/mobile/v1/capabilities', 'access-after-ui-stop-start', http, 200, { accessToken: tokensA.accessToken })
    facts.uiStopAndRestartSameIdentity = true
    await auditOffline(app, offline); protectors.push(await protectorFacts(app)); await closeNormally(app, closes); app = undefined
    await expectedTransportFailure(connection, undefined, 'TRANSPORT_CLOSED'); ownedStates.push(await closedOwnedState(profile))

    stage = '第二次冷启动与原刷新回执'
    app = await launch(profile, pageErrors); page = await waitForMainWindow(app); await controlProtector(app, protectorKey); panel = await mobilePanel(page)
    expect((await settings(page)).connection).toBeNull()
    // 离线E2E禁用自动restore，冷重开再次真实点击开启；不宣称已验证正常用户自动恢复。
    connection = await enable(page, panel, port); expect(connection).toEqual(originalConnection)
    const coldRefresh = await jsonSuccess(connection, 'refreshToken', '/mobile/v1/auth/refresh', 'cold-original-refresh-receipt', http, 200, { method: 'POST', idempotencyKey: refreshKey, body: refreshBody })
    expect(coldRefresh.sha256).toBe(refreshed.sha256)
    await jsonSuccess(connection, 'getCapabilities', '/mobile/v1/capabilities', 'cold-access-A', http, 200, { accessToken: tokensA.accessToken })
    await jsonSuccess(connection, 'getCapabilities', '/mobile/v1/capabilities', 'cold-access-B', http, 200, { accessToken: tokensB.accessToken })
    const coldDevices = await settings(page); expect(coldDevices.devices.map(device => device.deviceId).sort()).toEqual([tokensA.deviceId, tokensB.deviceId].sort()); expect(coldDevices.devices.every(device => !device.revoked)).toBe(true)
    facts.coldIdentityAndOriginalRefreshReceiptPreserved = true; facts.automaticServiceRestore = 'NOT_RUN'

    stage = '真实UI按设备撤销与合法logout'
    // 开启的配置回执尚未查询设备；通过真实刷新按钮同步当前Owner列表。
    await panel.getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect(panel.locator('.mobile-paired-devices li')).toHaveCount(2)
    const deviceA = panel.locator('.mobile-paired-devices li').filter({ hasText: '001合成客户端A' }); await expect(deviceA).toHaveCount(1)
    await deviceA.getByRole('button', { name: '撤销此设备', exact: true }).click(); await expect(deviceA).toContainText('已撤销'); await expect(deviceA.getByRole('button', { name: '撤销此设备', exact: true })).toHaveCount(0)
    await denied(connection, tokensA.accessToken, 'revoked-A-current-access', http)
    await wholeReply(connection, 'refreshToken', '/mobile/v1/auth/refresh', 'revoked-A-original-receipt-rejected', http, 401, { method: 'POST', idempotencyKey: refreshKey, body: refreshBody })
    await jsonSuccess(connection, 'getCapabilities', '/mobile/v1/capabilities', 'other-device-B-remains-current', http, 200, { accessToken: tokensB.accessToken })
    const logout = await jsonSuccess(connection, 'logout', '/mobile/v1/auth/logout', 'logout-B-empty-request-json', http, 204, { method: 'POST', accessToken: tokensB.accessToken, body: Buffer.from('{}') })
    expect(logout.body).toBeNull(); await denied(connection, tokensB.accessToken, 'logout-B-access-rejected', http)
    await panel.getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect(panel.locator('.mobile-paired-devices li').filter({ hasText: '001合成客户端B' })).toContainText('已撤销')
    const revoked = await settings(page); expect(revoked.devices).toHaveLength(2); expect(revoked.devices.every(device => device.revoked)).toBe(true)
    facts.revocation = { actualUiDeviceRevoke: true, currentAccessRejected: true, originalReceiptRejected: true, otherDeviceRemainedAuthorized: true, logout204EmptyBody: true }
    screenshots.push(await safeScreenshot(page, directory, '04-revoked-devices-no-permit.png'))
    await auditOffline(app, offline); protectors.push(await protectorFacts(app)); await closeNormally(app, closes); app = undefined
    await expectedTransportFailure(connection, undefined, 'TRANSPORT_CLOSED'); ownedStates.push(await closedOwnedState(profile))
    expect(ownedStates[1]!.identity).toEqual(ownedStates[0]!.identity); expect(ownedStates[1]!.sealedState.sha256 === ownedStates[0]!.sealedState.sha256).toBe(false)

    stage = '第三次冷启动撤销不复活与最终OFF'
    app = await launch(profile, pageErrors); page = await waitForMainWindow(app); await controlProtector(app, protectorKey); panel = await mobilePanel(page)
    connection = await enable(page, panel, port); expect(connection).toEqual(originalConnection)
    const finalDevices = await settings(page); expect(finalDevices.devices).toHaveLength(2); expect(finalDevices.devices.every(device => device.revoked)).toBe(true)
    await denied(connection, tokensA.accessToken, 'cold-revoked-A-access', http); await denied(connection, tokensB.accessToken, 'cold-logged-out-B-access', http)
    await wholeReply(connection, 'refreshToken', '/mobile/v1/auth/refresh', 'cold-revoked-A-original-receipt', http, 401, { method: 'POST', idempotencyKey: refreshKey, body: refreshBody })
    await disable(page, panel); await expectedTransportFailure(connection, undefined, 'TRANSPORT_CLOSED')
    screenshots.push(await safeScreenshot(page, directory, '05-final-off.png'))
    facts.coldRevocationPreserved = true; facts.finalOff = true
    await auditOffline(app, offline); protectors.push(await protectorFacts(app)); await closeNormally(app, closes); app = undefined
    ownedStates.push(await closedOwnedState(profile)); expect(ownedStates[2]!.identity).toEqual(ownedStates[0]!.identity); expect(ownedStates[2]!.sealedState).toEqual(ownedStates[1]!.sealedState)
    expect(protectors[0]!.encryptCalls > 0).toBe(true); expect(protectors[1]!.decryptCalls > 0).toBe(true); expect(protectors[2]!.decryptCalls > 0).toBe(true)
    expect(closes).toHaveLength(3); expect(new Set(closes.map(close => close.pid)).size).toBe(3); expect(offline).toHaveLength(3); expect(pageErrors.count).toBe(0)
    expect(new Set(http.map(row => row.operation)).size).toBe(10)
    facts.actualTenOperationResponses = [...new Set(http.map(row => row.operation))].sort(); facts.actualMainHttpsCoreOwnerRenderer = true
    stage = '全部业务断言完成'; completed = true
  } catch (error) {
    // 不附带原异常message/stack/cause：失败的actual/expected可能含合成token。
    if (error instanceof OwnedMainEvaluationError) mainFailure = { phase: error.phase, code: error.code }
    failureKind = error instanceof OwnedMainEvaluationError ? error.code : error instanceof OwnedRequestError ? error.kind : error instanceof Error && ['TimeoutError', 'AssertionError', 'Error'].includes(error.name) ? error.name : 'UNCLASSIFIED'
  } finally {
    if (app) {
      try { await auditOffline(app, offline); protectors.push(await protectorFacts(app)) } catch { completed = false; failureKind ??= 'CLEANUP_AUDIT_FAILED' }
      try { await closeNormally(app, closes) } catch { completed = false; failureKind ??= 'NATURAL_CLOSE_FAILED' }
    }
    protectorKey.fill(0)
    await writeFile(path.join(directory, completed ? 'receipt.json' : 'failure.json'), JSON.stringify({ schema: 'mbm001.owned-production-mobile-connection-app.v1', completed, stage, failureKind, mainFailure, profile: path.basename(profile), facts, http, closes, offline, controlledProtectors: protectors, screenshots, ownedStates, pageErrorCount: pageErrors.count, plaintextSecretsInDiagnostics: false, syntheticTokenOrPermitArchived: false, productEncryptedPrivateStateRetained: true, wholeResponseBodiesArchived: false, tests: 1, retries: 0 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  if (!completed) throw new Error('001自有生产HTTPS集成未完成；阶段：' + stage + '；分类：' + failureKind + '。私有failure只含无密钥事实。')
})

test('001生产唯一Owner扫描自有WAVE、真实PNG选图与HTTPS原生JPEG三尺寸及旧选择拒绝', async () => {
  test.setTimeout(240_000)
  const directory = await mkdtemp(path.join(e2eTemporaryRoot(), 'mbm001-mobile-artwork-'))
  const profile = path.join(directory, 'musicbridge-ui-e2e-' + path.basename(directory)), source = path.join(directory, 'owned-source')
  await Promise.all([profile, source].map(file => mkdir(file, { mode: 0o700 })))
  const wave = ownedWave(), pngA = ownedPng(0), pngB = ownedPng(1)
  const material = [{ fileName: 'owned-source/owned-artwork.wav', bytes: wave }, { fileName: 'owned-artwork-A.png', bytes: pngA }, { fileName: 'owned-artwork-B.png', bytes: pngB }]
  const before: FileIdentity[] = []
  for (const item of material) {
    await writeFile(path.join(directory, item.fileName), item.bytes, { flag: 'wx', mode: 0o600 })
    const identity = await fileIdentity(path.join(directory, item.fileName), item.fileName); expect(identity.sha256).toBe(sha(item.bytes)); before.push(identity)
  }
  await writeFile(path.join(directory, 'pre-app-baselines.json'), JSON.stringify({ schema: 'mbm001.owned-artwork-pre-app-materials.v1', allContentOwned: true, capturedBeforeFirstApp: true, files: before }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const protectorKey = randomBytes(32), port = await ownPort(), pageErrors = { count: 0 }
  const closes: CloseObservation[] = [], offline: OfflineObservation[] = [], protectors: ProtectorObservation[] = [], http: HttpObservation[] = [], screenshots: FileIdentity[] = []
  const nativeImages: Awaited<ReturnType<typeof nativeArtwork>>[] = [], after: FileIdentity[] = []
  const facts: Record<string, unknown> = { allContentOwned: true, productionDist: true, controlledProtector: true, actualKeychain: 'NOT_RUN', realProvider: 'NOT_RUN', realRoon: 'NOT_RUN', devicePlayback: 'NOT_RUN', ownerAcceptance: 'NOT_RUN', multiPageCatalog: 'NOT_RUN' }
  let app: ElectronApplication | undefined, ownedState: Awaited<ReturnType<typeof closedOwnedState>> | null = null, completed = false, stage = '自有扫描材料启动', failureKind: string | null = null
  let mainFailure: { phase: MainEvaluationPhase; code: SafeMainFailureCode } | null = null
  try {
    app = await launch(profile, pageErrors); const page = await waitForMainWindow(app); await controlProtector(app, protectorKey)
    const empty = await page.evaluate(() => window.musicBridge.queryLocalLibraryTracks({ query: '', rootId: null, offset: 0, limit: 100 }))
    expect(empty.total).toBe(0); expect(empty.items).toEqual([]); facts.initialLibraryEmpty = true
    await page.locator('[data-sidebar-source="local-library"]').click()
    const view = page.getByTestId('local-library-view'); await expect(view).toBeVisible()
    const management = view.locator('.local-library-management'); await management.locator(':scope > summary').click()
    await ownDirectoryPicker(app, source)
    await management.getByRole('button', { name: '授权源目录并加入音乐库', exact: true }).click()
    await management.getByRole('button', { name: '增量扫描', exact: true }).click()
    await expect(management.getByRole('list', { name: '扫描任务' })).toContainText('已完成', { timeout: 45_000 })
    await view.getByRole('button', { name: '刷新', exact: true }).click(); await expect(view.locator('.local-results-summary')).toContainText('1 首', { timeout: 10_000 })
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { __ownedMobilePickerCalls: number }).__ownedMobilePickerCalls)).toBe(1)
    const rows = await page.evaluate(() => window.musicBridge.queryLocalLibraryTracks({ query: '', rootId: null, offset: 0, limit: 100 }))
    expect(rows.total).toBe(1); expect(rows.items).toHaveLength(1); expect(rows.hasMore).toBe(false)
    const trackId = rows.items[0]!.track.id, assetId = rows.items[0]!.asset.id

    stage = '真实发行与完整PNG选图'
    const initial = await page.evaluate(trackId => window.musicBridge.getLocalArtworkContext({ trackId, editionId: null }), trackId)
    const edition = await page.evaluate(({ trackId, expectedTrackRevision }) => window.musicBridge.createLocalArtworkEdition({ commandId: crypto.randomUUID(), trackId, expectedTrackRevision, title: '001 自有封面发行' }), { trackId, expectedTrackRevision: initial.trackRevision })
    const firstSelection = await importAndSelectOwnedPng(page, trackId, edition.id, pngA)
    expect(firstSelection.editionId).toBe(edition.id); expect(firstSelection.candidate?.original.sha256).toBe(sha(pngA))
    expect(firstSelection.candidate?.original.width).toBe(640); expect(firstSelection.candidate?.original.height).toBe(320); expect(firstSelection.mode).toBe('manual')
    const localDetail = await page.evaluate(trackId => window.musicBridge.getLocalLibraryTrackDetail(trackId), trackId)
    expect(localDetail.track.id).toBe(trackId); expect(localDetail.asset.id).toBe(assetId)
    expect(localDetail.fileParameters?.sampleRateHz).toBe(44100); expect(localDetail.fileParameters?.channels).toBe(1)
    facts.actualScanner = { trackId, assetId, sourceWholeSha256: sha(wave), tracks: 1, fakeQualification: false, directDatabaseInsertion: false }
    facts.firstSelection = { id: firstSelection.id, revision: firstSelection.revision, editionId: edition.id, originalSha256: firstSelection.candidate!.original.sha256, displaySha256: firstSelection.candidate!.display.sha256 }

    stage = '真实UI启用配对与非空单曲HTTP目录'
    let panel = await mobilePanel(page), connection = await enable(page, panel, port)
    const permission = await permit(page, panel); panel = permission.panel
    const pair = await jsonSuccess(connection, 'claimPairing', '/mobile/v1/pairings/claim', 'artwork-client-pair', http, 201, { method: 'POST', idempotencyKey: randomUUID(), body: Buffer.from(JSON.stringify({ pairingSecret: permission.secret, installationId: randomUUID(), deviceName: '001原生封面合成客户端' })) })
    const tokens = pair.body
    const albums = await jsonSuccess(connection, 'listAlbums', '/mobile/v1/albums?source=local&limit=100', 'one-real-album', http, 200, { accessToken: tokens.accessToken })
    const tracks = await jsonSuccess(connection, 'listTracks', '/mobile/v1/tracks?source=local&limit=100', 'one-real-track', http, 200, { accessToken: tokens.accessToken })
    expect(albums.body.items).toHaveLength(1); expect(tracks.body.items).toHaveLength(1); expect(albums.body.nextCursor).toBeNull(); expect(tracks.body.nextCursor).toBeNull()
    const track = tracks.body.items[0]!, album = albums.body.items[0]!
    const datasetId = await page.evaluate(async () => (await window.musicBridge.getCommandOutbox()).datasetId)
    expect(track.id).toBe(`lt:${datasetId}:${trackId}:${edition.id}`); expect(album.id).toBe(`la:${datasetId}:${edition.id}`); expect(track.albumId).toBe(album.id)
    expect(track.source).toBe('local'); expect(track.availability).toBe('unavailable'); expect(track.durationMs).toBe(200)
    expect(track.audio.sampleRateHz).toBe(44100); expect(track.audio.channels).toBe(1); expect(track.audio.bitsPerSample).toBe(16)
    const artworkId = track.artworkId
    if (!artworkId) throw new Error('001实际已选择封面未产生公开artworkId。')
    expect(artworkId).toBe(`aw:${datasetId}:${firstSelection.id}:${firstSelection.revision}`); expect(album.artworkId).toBe(artworkId)
    const fullTrack = await jsonSuccess(connection, 'getTrack', '/mobile/v1/tracks/' + track.id, 'actual-track-detail', http, 200, { accessToken: tokens.accessToken })
    const fullAlbum = await jsonSuccess(connection, 'getAlbum', '/mobile/v1/albums/' + album.id, 'actual-album-detail', http, 200, { accessToken: tokens.accessToken })
    expect(fullTrack.body).toEqual(track); expect(fullAlbum.body).toEqual(album)
    expect(JSON.stringify(track).includes(source)).toBe(false); expect(JSON.stringify(album).includes(source)).toBe(false)
    facts.catalog = { actualTrack: track, actualAlbum: album, libraryRevision: tracks.body.libraryRevision, oneOwnedTrackOnly: true, nextCursor: null, multiPageVerified: false, currentAudioParametersFromActualSource: true, resourceOrPlaybackGranted: false }

    stage = 'HTTPS完整JPEG三尺寸与App原生解码'
    for (const size of [96, 256, 512] as const) nativeImages.push(await nativeArtwork(app, connection, artworkId, tokens.accessToken, size, directory, 'first-selection', http))
    screenshots.push(await safeScreenshot(page, directory, '01-selected-artwork-public-connection.png'))

    stage = '第二真实PNG选择围栏与旧artworkId拒绝'
    const secondSelection = await importAndSelectOwnedPng(page, trackId, edition.id, pngB)
    expect(secondSelection.id).toBe(firstSelection.id); expect(BigInt(secondSelection.revision)).toBe(BigInt(firstSelection.revision) + 1n)
    expect(secondSelection.candidate?.original.sha256).toBe(sha(pngB)); expect(secondSelection.candidate?.display.sha256 === firstSelection.candidate?.display.sha256).toBe(false)
    const stale = await wholeReply(connection, 'getArtwork', '/mobile/v1/artwork/' + artworkId + '?size=96', 'old-artwork-id-rejected', http, 409, { accessToken: tokens.accessToken })
    expect((stale.body as MobileErrorEnvelope).error.code).toBe('SOURCE_CHANGED')
    const changedTracks = await jsonSuccess(connection, 'listTracks', '/mobile/v1/tracks?source=local&limit=100', 'new-selection-actual-track-page', http, 200, { accessToken: tokens.accessToken })
    expect(changedTracks.body.items).toHaveLength(1)
    const changed = changedTracks.body.items[0]!, nextArtworkId = changed.artworkId
    if (!nextArtworkId) throw new Error('001新选择公开artworkId缺失。')
    expect(nextArtworkId).toBe(`aw:${datasetId}:${secondSelection.id}:${secondSelection.revision}`); expect(nextArtworkId === artworkId).toBe(false)
    const { artworkId: oldId, ...oldBody } = track, { artworkId: nextId, ...newBody } = changed
    expect(oldId).toBe(artworkId); expect(nextId).toBe(nextArtworkId); expect(newBody).toEqual(oldBody)
    for (const size of [96, 256, 512] as const) {
      const image = await nativeArtwork(app, connection, nextArtworkId, tokens.accessToken, size, directory, 'second-selection', http)
      expect(image.jpegSha256 === nativeImages.find(value => value.size === size)!.jpegSha256).toBe(false); nativeImages.push(image)
    }
    facts.secondSelection = { id: secondSelection.id, revision: secondSelection.revision, originalSha256: secondSelection.candidate!.original.sha256, displaySha256: secondSelection.candidate!.display.sha256, oldArtworkIdRejected: true, originalTrackContentIdentityPreserved: true }
    await disable(page, panel); await expectedTransportFailure(connection, undefined, 'TRANSPORT_CLOSED')
    facts.actualMainHttpsOwnerAndNativeArtwork = true
    await auditOffline(app, offline); protectors.push(await protectorFacts(app)); await closeNormally(app, closes); app = undefined
    ownedState = await closedOwnedState(profile, { assets: 1, tracks: 1 })
    for (const item of material) after.push(await fileIdentity(path.join(directory, item.fileName), item.fileName))
    expect(after).toEqual(before); expect(nativeImages).toHaveLength(6); expect(closes).toHaveLength(1); expect(offline).toHaveLength(1); expect(pageErrors.count).toBe(0)
    stage = '正向原生图像与旧选择全部断言完成'; completed = true
  } catch (error) {
    if (error instanceof OwnedMainEvaluationError) mainFailure = { phase: error.phase, code: error.code }
    failureKind = error instanceof OwnedMainEvaluationError ? error.code : error instanceof OwnedRequestError ? error.kind : error instanceof Error && ['TimeoutError', 'AssertionError', 'Error'].includes(error.name) ? error.name : 'UNCLASSIFIED'
  } finally {
    if (app) {
      try { await auditOffline(app, offline); protectors.push(await protectorFacts(app)) } catch { completed = false; failureKind ??= 'CLEANUP_AUDIT_FAILED' }
      try { await closeNormally(app, closes) } catch { completed = false; failureKind ??= 'NATURAL_CLOSE_FAILED' }
    }
    protectorKey.fill(0)
    await writeFile(path.join(directory, completed ? 'receipt.json' : 'failure.json'), JSON.stringify({ schema: 'mbm001.owned-production-mobile-artwork-app.v1', completed, stage, failureKind, mainFailure, profile: path.basename(profile), facts, http, nativeImages, closes, offline, controlledProtectors: protectors, screenshots, materialsBefore: before, materialsAfter: after, ownedState, pageErrorCount: pageErrors.count, plaintextSecretsInDiagnostics: false, syntheticTokenOrPermitArchived: false, productEncryptedPrivateStateRetained: true, tests: 1, retries: 0 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  if (!completed) throw new Error('001自有生产封面HTTPS集成未完成；阶段：' + stage + '；分类：' + failureKind + '。未用空页代替正向图像。')
})
