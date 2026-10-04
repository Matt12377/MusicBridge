import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'

const sha = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex')
const fixture = (name: string) => readFileSync(new URL('./fixtures/provider-crypto-4401/' + name, import.meta.url))
const original = fixture('official-original-crypto.cjs').toString()
assert.equal(sha(original), '192556e34ed897e367be23349b633db245dd65751ac45a5c055f765bba62e462')
const goldenBytes = fixture('old-weapi-64-golden.json')
assert.equal(sha(goldenBytes), 'b88286b1900b2f9590bff0189617e9d71ca1bb0823ed0cdc38df89ad9dcf570a')
const golden = JSON.parse(goldenBytes.toString())
const dependency = createRequire(import.meta.url)
const installed = realpathSync(dependency.resolve('@neteasecloudmusicapienhanced/api/util/crypto.js'))
const installedRequire = createRequire(installed), current = readFileSync(installed, 'utf8')
const names = ['weapi', 'linuxapi', 'eapi', 'xeapi', 'decrypt', 'aesEncrypt', 'aesDecrypt', 'eapiReqDecrypt', 'eapiResDecrypt', 'xeapiSign', 'xeapiResDecrypt', 'xeapiDecryptPublicKey']
const pem = original.match(/const publicKey = `([^`]+)`/u)![1]!
const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.alloc(32, 17)]), type: 'pkcs8', format: 'der' })
const pair = { privateKey, publicKey: crypto.createPublicKey(privateKey) }
const peer = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.alloc(32, 34)]), type: 'pkcs8', format: 'der' })).export({ type: 'spki', format: 'der' }).subarray(-32)
function load(source: string, secret = 'abcdefghijklmnop', exposeRsa = false) {
  let calls = 0, randomCounter = 0
  const math = Object.create(Math) as Math
  math.random = () => { const char = secret[calls++]!; assert.ok(char, 'weapi不能超出16随机调用'); return golden.alphabet.indexOf(char) / 61 }
  const facade = { ...crypto, randomBytes: (size: number) => Buffer.alloc(size, ++randomCounter), generateKeyPairSync: (kind: string) => { assert.equal(kind, 'x25519'); return pair } }
  const module = { exports: {} as Record<string, (...args: any[]) => any> }
  const require = (name: string) => {
    if (name === 'crypto') return facade
    // 历史非RSA差分不引入forge到产品；所有调用若误走该路径立即拒绝。
    if (name === 'node-forge') return { pki: { publicKeyFromPem: () => { throw new Error('禁止非RSA差分调用旧forge') } } }
    return installedRequire(name)
  }
  vm.runInNewContext(source + (exposeRsa ? '\nmodule.exports.__rsa = rsaEncrypt\n' : ''), { module, exports: module.exports, require, Buffer, Math: math, URL, URLSearchParams, console: { log: () => undefined } }, { filename: installed })
  return { api: module.exports, calls: () => calls }
}
function integer(bytes: Buffer): bigint { return BigInt('0x' + (bytes.toString('hex') || '0')) }
function modularPower(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  while (exponent > 0n) { if (exponent & 1n) result = result * base % modulus; base = base * base % modulus; exponent >>= 1n }
  return result
}
const jwk = crypto.createPublicKey(pem).export({ format: 'jwk' })
const modulusBytes = Buffer.from(jwk.n!, 'base64url'), modulus = integer(modulusBytes), exponent = integer(Buffer.from(jwk.e!, 'base64url'))
const oracle = (secret: string) => modularPower(integer(Buffer.from([...secret].reverse().join(''), 'latin1')), exponent, modulus).toString(16).padStart(modulusBytes.length * 2, '0')
const normalize = (value: any): any => {
  if (Buffer.isBuffer(value)) return { buffer: value.toString('hex') }
  if (value && typeof value.sigBytes === 'number' && Array.isArray(value.words)) return { wordArray: value.toString() }
  return JSON.parse(JSON.stringify(value))
}

test('API4.40.1真实安装后像与精确补丁身份，12导出及所有非RSA源码逐字节保留', () => {
  assert.equal(sha(current), '2fb5a857004faf85f669f0c5bf2755d53859bf27011dfe0410969f62bc8570a6')
  assert.doesNotMatch(current, /require\(['"]node-forge['"]\)/u)
  assert.equal(sha(readFileSync(new URL('../../../patches/@neteasecloudmusicapienhanced__api@4.40.1.patch', import.meta.url))), '5794b1e31014590ccbef952492ca10fa683478c369ca62b0841c06c39ff62f0e')
  assert.deepEqual(Object.keys(load(current).api), names)
  const withoutRsa = (source: string) => source.replace("const forge = require('node-forge')\n", '').replace(/const rsaEncrypt = [\s\S]*?\n\}\n\nconst weapi/u, 'const weapi')
  assert.equal(withoutRsa(current), withoutRsa(original))
})
for (const vector of golden.vectors) test('原forge固定weapi黄金与独立模幂：' + vector.id, () => {
  const actual = load(current, vector.secret), value = actual.api.weapi!(vector.payload)
  assert.deepEqual(normalize(value), vector.expected)
  assert.equal(actual.calls(), 16); assert.equal(value.encSecKey, oracle(vector.secret)); assert.match(value.encSecKey, /^[a-f0-9]{256}$/u)
})
test('raw RSA primitive模数定宽/latin1/错误边界，生产合同仍仅16字节base62', () => {
  const api = load(current, undefined, true).api
  for (const input of ['', 'é', 'z'.repeat(16)]) {
    const expected = modularPower(integer(Buffer.from(input, 'latin1')), exponent, modulus).toString(16).padStart(256, '0')
    assert.equal(api.__rsa!(input, pem), expected)
  }
  assert.throws(() => api.__rsa!('a'.repeat(129), pem), /超过模数宽度/u)
  assert.throws(() => api.__rsa!('x', 'invalid key'))
  assert.throws(() => api.__rsa!('\xff'.repeat(128), pem))
})
const plain = { title: '离线樱花🎵', nested: { number: 7, value: '引号"与反斜线\\' } }, url = '/api/synthetic/test'
const eapiKey = 'e82ckenh8dichen8', staticKey = Buffer.from('ab1d5a430f6bb04a3f01e81ddd72bd916d5ce591248ac128714806d7f8fb1b84', 'hex')
function nativeEcb(key: Buffer, input: Buffer) { const c = crypto.createCipheriv('aes-' + key.length * 8 + '-ecb', key, null); return Buffer.concat([c.update(input), c.final()]) }
function legacyDecryptFixture(api: Record<string, (...args: any[]) => any>) {
  // 旧decrypt使用口令派生模式；固定测试salt后按同一合同生成密文。
  const CryptoJS = installedRequire('crypto-js'), salt = CryptoJS.enc.Hex.parse('0011223344556677')
  const random = CryptoJS.lib.WordArray.random
  try {
    CryptoJS.lib.WordArray.random = (size: number) => { assert.equal(size, 8); return salt.clone() }
    const ciphertext = CryptoJS.AES.encrypt(JSON.stringify(plain), eapiKey, { mode: CryptoJS.mode.ECB, salt: salt.clone() }).ciphertext.toString()
    const result = api.decrypt!(ciphertext)
    assert.equal(result, JSON.stringify(plain))
    return result
  } finally { CryptoJS.lib.WordArray.random = random }
}
const scenarios: Record<string, (api: Record<string, (...args: any[]) => any>) => any> = {
  linuxapi: api => api.linuxapi!(plain), eapi: api => api.eapi!(url, plain),
  aesEncrypt: api => api.aesEncrypt!('合成明文🎵', 'cbc', '0123456789abcdef', '0102030405060708'),
  aesDecrypt: api => api.aesDecrypt!(api.aesEncrypt!('合成明文🎵', 'cbc', '0123456789abcdef', '0102030405060708'), 'cbc', '0123456789abcdef', '0102030405060708'),
  decrypt: legacyDecryptFixture, eapiReqDecrypt: api => api.eapiReqDecrypt!(api.eapi!(url, plain).params),
  eapiResDecrypt: api => api.eapiResDecrypt!(nativeEcb(Buffer.from(eapiKey), Buffer.from(JSON.stringify(plain))).toString('hex')),
  eapiResDecryptCompressed: api => api.eapiResDecrypt!(nativeEcb(Buffer.from(eapiKey), zlib.gzipSync(Buffer.from(JSON.stringify(plain)))).toString('hex'), true),
  xeapiSign: api => api.xeapiSign!(1720000000000, 'synthetic-nonce'),
  xeapi: api => api.xeapi!('/eapi/synthetic?query=合成', { title: '樱花', e_r: false }, { publicKeyState: { publicKey: peer.toString('base64'), version: 'fixture', sk: 'synthetic' }, sessionKey: '0123456789abcdef', sessionId: 'synthetic-session' }),
  xeapiResDecrypt: api => api.xeapiResDecrypt!(nativeEcb(Buffer.from(eapiKey), Buffer.from(JSON.stringify(plain)))),
  xeapiResDecryptCompressed: api => api.xeapiResDecrypt!(nativeEcb(Buffer.from(eapiKey), zlib.gzipSync(Buffer.from(JSON.stringify(plain))))),
  xeapiDecryptPublicKey: api => api.xeapiDecryptPublicKey!(nativeEcb(staticKey, Buffer.from(JSON.stringify({ publicKey: peer.toString('base64'), version: 'fixture' }))).toString('base64')),
}
for (const [name, invoke] of Object.entries(scenarios)) test('保全非RSA导出实际离线旧/新差分：' + name, () => assert.deepEqual(normalize(invoke(load(current).api)), normalize(invoke(load(original).api))))
for (const [name, invoke] of Object.entries({ circular: (api: any) => { const value: any = {}; value.self = value; return api.weapi(value) }, bigint: (api: any) => api.weapi({ value: 1n }), missingXeapiKey: (api: any) => api.xeapi(url, plain) })) test('保全原公开输入错误语义：' + name, () => {
  const error = (source: string) => { try { invoke(load(source).api); assert.fail('此输入应拒绝') } catch (value: any) { return { name: value.name, message: value.message } } }
  assert.deepEqual(error(current), error(original))
})
