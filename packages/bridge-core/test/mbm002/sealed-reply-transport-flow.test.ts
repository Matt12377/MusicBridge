import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { MessageChannel, type Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../../../../apps/desktop/src/main/core-supervisor.js';
import { attachCoreRuntimePort, type CoreRuntimeForIpc } from '../../src/utility-main.js';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js';
import type { OwnedDatasetDomain } from '../../src/collection/dataset-owner-protocol.js';
import { createMobileOwnerService } from '../../src/mobile/owner-service.js';
import { allocateOwnedSealedBytes } from '../../src/mobile/owned-sealed-bytes.js';
import type { CollectionRepository } from '../../src/collection/repository.js';
import { MobileAuthPersistenceError, type MobileOwnerPrivateRequest } from '../../src/mobile/types.js';
import { failureForError } from '../../src/shared/ipc-failure.js';
import { createMobileAuthService } from '../../src/mobile/auth-service.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { encodeMobileSealedCoreRequest } from '../../src/mobile/sealed-request-transport.js';

const DATASET = '50000000-0000-4000-8000-000000000038';
class NativePort implements CoreMessagePort {
  constructor(readonly port: MessageChannel['port1']) {}
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.port.on('message', data => listener({ data })); }
  start() { this.port.start(); }
  close() { this.port.close(); }
  postMessage(value: unknown) { this.port.postMessage(value); }
}
async function fixture(t: TestContext) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'sealed-transport-')); fs.chmodSync(directory, 0o700);
  const ownerChannel = new MessageChannel(), worker = new EventEmitter(), reasons: string[] = [];
  Object.assign(worker, { postMessage(value: unknown) { ownerChannel.port1.postMessage(value); } });
  ownerChannel.port1.on('message', value => worker.emit('message', value));
  ownerChannel.port1.once('close', () => worker.emit('exit', 0));
  const owner = createMobileOwnerService({ collection: { privateMobileDataDirectory: () => directory } as unknown as CollectionRepository,
    datasetId: DATASET, ownerEpoch: 'owner.synthetic.transport', assertCurrent() {} });
  let calls = 0, shutdowns = 0, kills = 0, release: (() => void) | undefined, entered: (() => void) | undefined;
  let held: Promise<void> | undefined;
  const domain: OwnedDatasetDomain = { datasetId: DATASET, async dispatch() {}, commitBoot() {},
    async mobileMain(request) { calls++; if (held) { entered?.(); await held; } return owner.dispatch(request); },
    async close(before) { await before?.(); }, failureForError(id, error, command) { return failureForError(id, error, command ?? 'commandOutbox.context'); } };
  attachDatasetOwnerWorkerPort(ownerChannel.port2, { async prepare() { return domain; } });
  const endpoint = createDatasetOwnerClient({ worker: worker as unknown as Worker, onFatal: reason => reasons.push(reason) });
  await endpoint.prepare(); await endpoint.commitBoot();
  const channels: MessageChannel[] = [], child = { stdout: new EventEmitter(), stderr: new EventEmitter(), exits: [] as Array<(code: number) => void>,
    once(_event: 'exit', fn: (code: number) => void) { this.exits.push(fn); }, exit(code: number) { for (const fn of this.exits.splice(0)) fn(code); },
    kill() { kills++; this.exit(0); return true; },
    postMessage(_value: unknown, transferred?: CoreMessagePort[]) { void attachCoreRuntimePort(transferred![0]!, runtime); } };
  const runtime = { async start() {}, async shutdown() { shutdowns++; await endpoint.close(); setImmediate(() => child.exit(0)); },
    getState: () => ({ runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false }), datasetOwnerEndpoint: endpoint } as unknown as CoreRuntimeForIpc;
  const supervisor = new CoreSupervisor({ entryPath: '/synthetic/transport-core.js', cwd: '/synthetic', startupTimeoutMs: 2000,
    requestTimeoutMs: 1000, dependencies: { fork: () => child as CoreChildProcess, createChannel() {
      const c = new MessageChannel(); channels.push(c); return { port1: new NativePort(c.port1), port2: new NativePort(c.port2) }; } } });
  await supervisor.start();
  t.after(async () => { release?.(); await supervisor.shutdown(); ownerChannel.port1.close(); ownerChannel.port2.close();
    for (const c of channels) { c.port1.close(); c.port2.close(); }
    fs.rmSync(directory, { recursive: true, force: true }); assert.equal(shutdowns, 1); assert.equal(kills, 0); assert.deepEqual(reasons, []); });
  return { supervisor, rawCorePort: channels[0]!.port2, calls: () => calls, hold() {
    held = new Promise<void>(yes => { release = () => { held = undefined; yes(); }; });
    return { entered: new Promise<void>(yes => { entered = yes; }), release: () => release?.() };
  } };
}

for(const kind of ['load','playback-load']as const)test(`M52两跳真实load ${kind}不枚举字节索引且每次新鲜到Owner`,{timeout:20000},async t=>{
 const f=await fixture(t),bytes=allocateOwnedSealedBytes(90112);bytes.fill(52);
 const saved=await f.supervisor.requestMobileMain({kind:kind==='load'?'save':'playback-save',datasetId:DATASET,request:{datasetId:DATASET,expectedRevision:0,commitId:randomUUID(),sealed:bytes}});
 assert.ok('kind'in saved);assert.equal(saved.kind,'saved');const original=Reflect.ownKeys;let scans=0;
 Reflect.ownKeys=value=>{if(value instanceof Uint8Array)scans++;return original(value);};
 let loaded:Awaited<ReturnType<typeof f.supervisor.requestMobileMain>>;
 try{loaded=await f.supervisor.requestMobileMain({kind,datasetId:DATASET});}finally{Reflect.ownKeys=original;}
 assert.ok('kind'in loaded);assert.equal(loaded.kind,'sealed');assert.ok(loaded.kind==='sealed');assert.equal(loaded.sealed.byteLength,90112);assert.ok(loaded.sealed.every(n=>n===52));
 assert.equal(scans,0,'新鲜load回复两跳不对每个密文字节枚举索引。');
 loaded.sealed.fill(0);const again=await f.supervisor.requestMobileMain({kind,datasetId:DATASET});assert.ok('kind'in again&&again.kind==='sealed');assert.ok(again.sealed.every(n=>n===52));assert.equal(f.calls(),3);
});

test('M52真实auth经过两跳load：refresh代际和撤销每次新鲜复核，不复用旧许可',async t=>{
 const f=await fixture(t);let loads=0;
 const auth=createMobileAuthService({serverId:'server-owned',datasetId:DATASET,displayName:'合成设备桥',environment:'development',crypto:createMobileAuthCrypto(new Uint8Array(32).fill(52)),
 persistence:{async load(datasetId){loads++;return await f.supervisor.requestMobileMain({kind:'load',datasetId})as Awaited<ReturnType<import('../../src/mobile/types.js').MobileAuthPersistence['load']>>;},async save(request){return await f.supervisor.requestMobileMain({kind:'save',datasetId:DATASET,request})as Awaited<ReturnType<import('../../src/mobile/types.js').MobileAuthPersistence['save']>>;}}});
 t.after(()=>auth.close());const permit=await auth.issuePairing(),pair=await auth.claim({pairingSecret:permit.pairingSecret,installationId:'synthetic-installation',deviceName:'合成设备'},'claim-key');
 const principal=await auth.authenticate(pair.accessToken),before=loads;await auth.assertDeviceCurrent(principal.deviceId,principal.deviceEpoch);assert.equal(loads,before+1);
 const fresh=await auth.refresh({refreshToken:pair.refreshToken},'refresh-key');
 await assert.rejects(auth.assertCurrent(principal));await auth.assertDeviceCurrent(principal.deviceId,principal.deviceEpoch);
 const latest=await auth.authenticate(fresh.accessToken);await auth.revokeDevice(latest.deviceId);const revoked=loads;await assert.rejects(auth.assertDeviceCurrent(latest.deviceId,latest.deviceEpoch));assert.equal(loads,revoked+1);
});
test('M52关闭在途load保持UNKNOWN与真实quiet，不重发或晚回发布',async t=>{
 const f=await fixture(t),held=f.hold();const pending=f.supervisor.requestMobileMain({kind:'load',datasetId:DATASET});const rejected=assert.rejects(pending,error=>error instanceof MobileAuthPersistenceError&&error.outcome==='unknown');
 await held.entered;let quiet=false;const closing=f.supervisor.shutdown().then(()=>{quiet=true;});await new Promise<void>(done=>setImmediate(done));assert.equal(quiet,false);held.release();await rejected;await closing;assert.equal(f.calls(),1);assert.equal(quiet,true);
});
