import {createMobilePreparationProbe,captureMobileCapabilityContext} from '../../../../packages/bridge-core/src/mobile/capability-trace.js'
import {MOBILE_CATALOG_MARKER_PREFIX} from '../../../../packages/bridge-core/src/mobile/catalog-private-trace.js'
// @ts-expect-error 仓库内严格闭集ESM reader。
import {createCatalogPrivateReader} from '../../../../scripts/diagnostics/mobile/catalog-http-sidecar-reader.mjs'
import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest } from 'node:http'
import { checkServerIdentity, type ConnectionOptions } from 'node:tls'
import { mkdtemp, rm } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { MOBILE_JSON_REQUEST_MAX_BYTES, MOBILE_API_RESPONSE_MAX_BYTES } from '@music-bridge/contracts'
import { MobileServiceError, type Mobile001Backend, type Mobile001BackendReply, type Mobile001Operation } from '../../../../packages/bridge-core/src/mobile/types.js'
import { createMobileHttpsServer, MOBILE_HTTPS_LIMITS, MobileHttpsServerError } from '../../src/main/mobile-https-server.js'
import { loadOrCreateMobileIdentity, type MobileTlsIdentity } from '../../src/main/mobile-tls-identity.js'

/** 实际 TLS/HTTP/原 wire decoder，backend 是受控叶接口，不声称实际 Owner/Auth 服务采用。 */
let identity: MobileTlsIdentity, owned = ''
before(async () => {
  const parent = process.env.TMPDIR ?? (process.platform === 'darwin' ? '/Volumes/LifeWeave/Developer/CommandLine/tmp' : os.tmpdir())
  if (process.platform === 'darwin' && !parent.startsWith('/Volumes/LifeWeave/Developer/CommandLine/')) throw new Error('合成材料必须使用外置目录。')
  owned = await mkdtemp(path.join(parent, 'mbm001-https-'))
  const key = randomBytes(32)
  identity = await loadOrCreateMobileIdentity({ directory: path.join(owned, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  } })
})
after(async () => { if (owned) await rm(owned, { recursive: true, force: true }) })
const digest = (value: Buffer | Uint8Array) => createHash('sha256').update(value).digest('hex')
function serverInfo(displayName = '合成 HTTPS 目录') {
  return { serverId: identity.serverId, displayName, contractVersion: '0.1.0', environment: 'development' }
}
function jsonReply(body: unknown, status = 200): Mobile001BackendReply {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  return { status, headers: [['Content-Type', 'application/json'], ['Content-Length', String(bytes.byteLength)]], body: bytes }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(t: test.TestContext, backend: Mobile001Backend, port = 0) {
  const server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, host: '127.0.0.1', port, backend })
  t.after(() => server.close())
  const listening = await server.start()
  return { server, ...listening }
}
interface Result { status: number; body: Buffer; rawHeaders: string[] }
interface ClientOptions {
  method?: string; headers?: readonly string[]; body?: Buffer; servername?: string
  checkServerIdentity?: ConnectionOptions['checkServerIdentity']
}
function client(base: string, target: string, options: ClientOptions = {}): { request: ClientRequest; result: Promise<Result> } {
  const url = new URL(base), headers = ['Host', url.host, ...(options.headers ?? []), 'Connection', 'close']
  if (options.body !== undefined && !headers.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'content-length')) headers.push('Content-Length', String(options.body.length))
  let request!: ClientRequest
  const result = new Promise<Result>((resolve, reject) => {
    request = httpsRequest({ hostname: url.hostname, port: url.port, path: target, method: options.method ?? 'GET', headers,
      ca: identity.certificatePEM, agent: false,
      ...(options.servername ? { servername: options.servername } : {}),
      ...(options.checkServerIdentity ? { checkServerIdentity: options.checkServerIdentity } : {}),
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), rawHeaders: [...response.rawHeaders] }))
      response.once('error', reject); response.once('aborted', () => reject(new Error('合成响应已关闭。')))
    })
    request.once('error', reject); request.setTimeout(5000, () => request.destroy(new Error('合成请求等待已结束。')))
    request.end(options.body)
  })
  return { request, result }
}
const read = (base: string, target: string, options?: ClientOptions) => client(base, target, options).result
function png(size: number): Buffer {
  const chunk = (name: string, value: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), value]); let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1 }
    const length = Buffer.alloc(4), sum = Buffer.alloc(4); length.writeUInt32BE(value.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, sum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc((size * 4 + 1) * size))), chunk('IEND', Buffer.alloc(0))])
}

test('M48实际TLS/HTTP tracks第13请求失败后继续观察第14恢复，不更改HTTP结果',async t=>{
 const rows:any[]=[],reader=createCatalogPrivateReader({onRecord:(r:unknown)=>rows.push(r)}),stream=reader.createStream(),markers:any[]=[];
 const original=process.stdout.write;
 process.stdout.write=function(this:typeof process.stdout,chunk:any,...rest:any[]):boolean{
  const text=String(chunk);if(text.startsWith(MOBILE_CATALOG_MARKER_PREFIX)){markers.push(JSON.parse(text.slice(MOBILE_CATALOG_MARKER_PREFIX.length)));stream.write(text);return true;}
  return Reflect.apply(original,this,[chunk,...rest]);
 } as typeof process.stdout.write;
 t.after(()=>{process.stdout.write=original;stream.end();});
 let calls=0;const probe=createMobilePreparationProbe({enabled:true});probe.arm();
 const server=createMobileHttpsServer({tls:{key:identity.privateKeyPEM,cert:identity.certificatePEM},host:'127.0.0.1',port:0,preparationProbe:probe,
  backend:{async dispatch(request){assert.equal(request.operation,'listTracks');calls++;
   assert.equal(captureMobileCapabilityContext()?.privateContentDiagnostic,true);
   if(calls===13)throw new MobileServiceError(503,'BUSY');
   return jsonReply({items:[],nextCursor:null,libraryRevision:'revision.synthetic'});
  }}});
 t.after(()=>server.close());const listening=await server.start();
 for(let i=0;i<14;i++){const response=await read(listening.baseUrl,'/mobile/v1/tracks?source=local&limit=100');assert.equal(response.status,i===12?503:200);}
 assert.equal(calls,14);assert.equal(markers.filter(x=>x.kind==='http-begin').length,14);assert.equal(markers.filter(x=>x.kind==='http-terminal').length,14);
 const samples=rows.filter(x=>x.schema==='mb.catalog-http-sample.v1');assert.equal(samples.length,14);
 assert.deepEqual(samples.map(x=>x.status),Array.from({length:14},(_,i)=>i===12?503:200));
 assert.deepEqual(samples.map(x=>x.selection),Array.from({length:14},(_,i)=>i===12?'failure':'success'));
 assert.ok(samples.every(x=>x.complete&&!x.truncated&&x.finished));
 // 受控backend没有Core/Owner RPC，因此nonce/row真实为0，不能伪造跨进程完整链。
 for(const sample of samples){assert.equal(sample.nonceCount,0);assert.equal(sample.expectedNonceCount,0);assert.deepEqual(sample.scopes,[]);}
 assert.equal(rows.filter(x=>x.schema!=='mb.catalog-http-sample.v1').length,0);
 assert.equal(captureMobileCapabilityContext(),undefined,'请求上下文不能泄漏到调用方');
 await server.close();stream.end();
 const state=reader.snapshot();assert.equal(state.successRequestsPublished,13);assert.equal(state.failureRequestsPublished,1);
 for(const key of ['invalidRecords','oversizedLines','suppressedRecords','unregisteredRecords','sinkFailures','nonceCount','httpCount','bufferedRecords','bufferedBytes'])assert.equal(state[key],0,key);
 assert.equal(state.streamCount,1);assert.equal(state.rawStdoutPersisted,false);assert.equal(state.rawStderrPersisted,false);
});
