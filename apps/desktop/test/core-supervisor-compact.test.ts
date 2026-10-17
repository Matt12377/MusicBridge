import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import type { PlaybackStreamSnapshot, TypedIpcEvent } from '@music-bridge/contracts'
import * as main from '../src/main/core-supervisor.js'
import { writeLocalPlaybackGuardSync } from '../src/main/local-playback-evidence.js'

class Port implements main.CoreMessagePort {
  readonly sent: Array<{ id: string; command: string }> = []
  listener?: (event: { data: unknown }) => void
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.listener = listener }
  start() {}
  close() {}
  postMessage(value: unknown) {
    const request = value as { version?: unknown; id: string; command: string }
    this.sent.push(request)
    // 合成ACK按原id返回；Child仍独立决定是否真实发exit，不给播放/seed自动回包。
    if (request.version === 1 && request.command === 'core.shutdown') queueMicrotask(() => this.receive({ version: 1, id: request.id, ok: true, result: { stopped: true } }))
  }
  receive(data: unknown) { this.listener?.({ data }) }
  reply(result: unknown) { this.receive({ version: 1, id: this.sent.at(-1)!.id, ok: true, result }) }
}
class Child implements main.CoreChildProcess {
  posted: unknown[] = []
  listener?: (code: number) => void
  autoExit = true
  postMessage(value: unknown) { this.posted.push(value) }
  once(_event: 'exit', listener: (code: number) => void) { this.listener = listener }
  kill() { if (this.autoExit) this.exit(); return true }
  exit() { const listener = this.listener; this.listener = undefined; listener?.(0) }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const health = { runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false }
function seed(coreInstanceId: string, sequence = 1): PlaybackStreamSnapshot {
  return {
    stamp: { coreInstanceId, generation: 0, sequence, queueRevision: 1, selectedZoneId: null, trackId: null, source: null },
    snapshot: { state: 'idle', positionMs: 0, queue: { items: [], index: -1, hasNext: false, hasPrevious: false }, canNext: false, canPrevious: false, canStop: false, canPause: false, canResume: false },
  }
}
function harness(t: TestContext, options: {
  env?: NodeJS.ProcessEnv
  onReady?: (client: main.CoreStartupClient) => Promise<void> | void
  onEvent?: (event: TypedIpcEvent) => void
  onLifecycle?: (event: main.CoreSupervisorLifecycle) => void
} = {}) {
  const ports: Port[] = [], children: Child[] = [], events: TypedIpcEvent[] = []
  const supervisor = new main.CoreSupervisor({ entryPath: '/synthetic/core.js', cwd: '/synthetic', requestTimeoutMs: 5, startupTimeoutMs: 1_000,
    ...options,
    dependencies: {
      createChannel: () => { const port = new Port(); ports.push(port); return { port1: new Port(), port2: port } },
      fork: () => { const child = new Child(); children.push(child); return child },
    },
    onEvent: event => { events.push(event); options.onEvent?.(event) },
  })
  t.after(async () => { children.forEach(child => { child.autoExit = true }); await supervisor.shutdown() })
  const ready = (id?: string, index = ports.length - 1) => ports[index]!.receive({ version: 1, event: 'core.ready', payload: { state: health, ...(id ? { playbackEvents: { protocol: 'compact-v1', coreInstanceId: id } } : {}) } })
  return { supervisor, ports, children, events, ready }
}

test('006：默认private transfer显式compact；rollback0仅发送原legacy packet', async t => {
  for (const rollback of [false, true]) {
    const h = harness(t, { env: rollback ? { MUSIC_BRIDGE_COMPACT_PLAYBACK_EVENTS: '0' } : {} })
    const started = h.supervisor.start(); h.ready(); await started
    assert.deepEqual(h.children[0]!.posted[0], { type: 'musicbridge.core.port', ...(rollback ? {} : { playbackEventProtocol: 'compact-v1' }) })
  }
})

test('006：旧Core无ACK只启动一次，readonly返回null且不请求未知命令', async t => {
  const h = harness(t), started = h.supervisor.start(); h.ready(); await started
  assert.equal(await h.supervisor.getPlaybackStreamSnapshot(), null)
  assert.equal(h.ports[0]!.sent.length, 0); assert.equal(h.children.length, 1)
})

test('006：恢复hook完成后才请求seed；早delta丢弃，回复同步ready+seed', async t => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = harness(t, { onReady: () => gate }), id = randomUUID(), started = h.supervisor.start()
  h.ready(id); await tick()
  h.ports[0]!.receive({ version: 1, event: 'playback.snapshot', payload: seed(id) })
  assert.equal(h.events.length, 0); assert.equal(h.ports[0]!.sent.length, 0)
  release(); await tick()
  assert.equal(h.ports[0]!.sent.at(-1)?.command, 'playback.getStreamSnapshot'); assert.equal(h.supervisor.status, 'starting')
  h.ports[0]!.reply(seed(id, 3))
  assert.equal(h.supervisor.status, 'ready')
  assert.deepEqual(h.events.map(event => event.event), ['core.ready', 'playback.snapshot'])
  assert.deepEqual(h.events[1]!.payload, seed(id, 3)); await started
})

for (const bad of ['null', 'foreign'] as const) test(`006：ACK后${bad} seed明确失败且唯一重试，不伪降级`, async t => {
  const h = harness(t), started = h.supervisor.start().catch(error => error)
  for (let index = 0; index < 2; index++) {
    const id = randomUUID(); h.ready(id); await tick()
    assert.equal(h.ports[index]!.sent.at(-1)?.command, 'playback.getStreamSnapshot')
    h.ports[index]!.reply(bad === 'null' ? null : seed(randomUUID())); await tick()
  }
  assert.equal((await started).code, 'INVALID_IPC_RESPONSE'); assert.equal(h.children.length, 2)
  assert.equal(h.supervisor.status, 'failed'); assert.equal(h.events.length, 0)
})

test('006：rollback未请求却收到ACK拒绝，不接受Core自授模式', async t => {
  const h = harness(t, { env: { MUSIC_BRIDGE_COMPACT_PLAYBACK_EVENTS: '0' } }), started = h.supervisor.start().catch(error => error)
  h.ready(randomUUID()); await tick(); h.ready(randomUUID());
  assert.equal((await started).code, 'INVALID_IPC_RESPONSE'); assert.equal(h.events.length, 0)
})

test('006：ready回调同步shutdown撤销route，旧seed不得继续广播', async t => {
  let shutdown: Promise<void> | undefined
  const h = harness(t, { onEvent: event => { if (event.event === 'core.ready') shutdown = h.supervisor.shutdown() } })
  const started = h.supervisor.start().catch(error => error), id = randomUUID()
  h.ready(id); await tick(); h.ports[0]!.reply(seed(id)); await started; await shutdown
  assert.deepEqual(h.events.map(event => event.event), ['core.ready']); assert.equal(h.supervisor.status, 'stopped')
})

test('006：readonly回复已resolve后发生restart，await返回前仍拒旧child', async t => {
  const h = harness(t), id = randomUUID(), started = h.supervisor.start()
  h.ready(id); await tick(); h.ports[0]!.reply(seed(id)); await started
  const read = h.supervisor.getPlaybackStreamSnapshot().catch(error => error)
  h.ports[0]!.reply(seed(id)); const shutdown = h.supervisor.shutdown()
  assert.equal((await read).code, 'NOT_READY'); await shutdown
})

test('006：compact reload null/异instance均协议错误，后续合法readonly可恢复', async t => {
  const h = harness(t), id = randomUUID(), started = h.supervisor.start()
  h.ready(id); await tick(); h.ports[0]!.reply(seed(id)); await started
  for (const value of [null, seed(randomUUID())]) {
    const read = h.supervisor.getPlaybackStreamSnapshot().catch(error => error); h.ports[0]!.reply(value)
    assert.equal((await read).code, 'INVALID_IPC_RESPONSE')
  }
  const read = h.supervisor.getPlaybackStreamSnapshot(); h.ports[0]!.reply(seed(id, 5)); assert.deepEqual(await read, seed(id, 5))
})

test('006：compact进度不触发tray全读，full/health/legacy仍刷新', () => {
  const id = randomUUID()
  for (let i = 1; i <= 100; i++) assert.equal(main.shouldRefreshTrayForCoreEvent({ version: 1, event: 'playback.progress', payload: { stamp: seed(id, i).stamp, positionMs: i } }), false)
  assert.equal(main.shouldRefreshTrayForCoreEvent({ version: 1, event: 'playback.snapshot', payload: seed(id) }), true)
  assert.equal(main.shouldRefreshTrayForCoreEvent({ version: 1, event: 'core.health', payload: { state: health } } as TypedIpcEvent), true)
})

test('006：播放回执已resolve后撤销route仍拒返回旧播放事实', async t => {
  const h = harness(t), id = randomUUID(), started = h.supervisor.start()
  h.ready(id); await tick(); h.ports[0]!.reply(seed(id)); await started
  const read = h.supervisor.request('playback.getState', {}).catch(error => error)
  h.ports[0]!.reply({ ...seed(id).snapshot, stream: seed(id).stamp })
  const shutdown = h.supervisor.shutdown()
  assert.equal((await read).code, 'NOT_READY'); await shutdown
})

test('006：compact播放回执异instance拒绝，缺stamp仍保留原ACK合同', async t => {
  const h = harness(t), id = randomUUID(), started = h.supervisor.start()
  h.ready(id); await tick(); h.ports[0]!.reply(seed(id)); await started
  const read = h.supervisor.request('playback.getState', {}).catch(error => error)
  h.ports[0]!.reply({ ...seed(id).snapshot, stream: seed(randomUUID()).stamp })
  assert.equal((await read).code, 'INVALID_IPC_RESPONSE')
  const oldReceipt = h.supervisor.request('playback.getState', {}); h.ports[0]!.reply(seed(id).snapshot)
  assert.deepEqual(await oldReceipt, seed(id).snapshot)
})

test('006：seed失败kill未真实exit，不fork第二writer', async t => {
  const h = harness(t), started = h.supervisor.start().catch(error => error), id = randomUUID()
  h.children[0]!.autoExit = false; h.ready(id); await tick(); h.ports[0]!.reply(null)
  assert.equal((await started).code, 'NOT_READY'); assert.equal(h.children.length, 1)
  assert.equal(h.supervisor.status, 'failed'); h.children[0]!.exit(); await tick()
  assert.equal(h.children.length, 1)
})

test('006：trusted恢复client只读ACK；compact仅转发同instance事件且不双发legacy', async t => {
  let client: main.CoreStartupClient | undefined
  const h = harness(t, { onReady: value => { client = value } }), id = randomUUID(), started = h.supervisor.start()
  h.ready(id); await tick(); assert.deepEqual(client?.playbackEvents, { protocol: 'compact-v1', coreInstanceId: id })
  h.ports[0]!.reply(seed(id)); await started
  h.ports[0]!.receive({ version: 1, event: 'playback.snapshot', payload: seed(randomUUID()) })
  h.ports[0]!.receive({ version: 1, event: 'playback.changed', payload: { snapshot: seed(id).snapshot } })
  h.ports[0]!.receive({ version: 1, event: 'playback.progress', payload: { stamp: seed(id, 2).stamp, positionMs: 4 } })
  assert.deepEqual(h.events.map(event => event.event), ['core.ready', 'playback.snapshot', 'playback.progress'])
})

test('006：seed不回包占原启动总预算，旧晚回复不能越过第二次seed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(t), started = h.supervisor.start(), first = randomUUID(), second = randomUUID()
  h.ready(first); await tick(); assert.equal(h.ports[0]!.sent.at(-1)?.command, 'playback.getStreamSnapshot')
  t.mock.timers.tick(1_001); await tick()
  assert.equal(h.children.length, 2); assert.equal(h.supervisor.status, 'starting')
  h.ports[0]!.reply(seed(first)); assert.equal(h.events.length, 0)
  h.ready(second); await tick(); h.ports[1]!.reply(seed(second)); await started
  assert.deepEqual(h.events.map(event => event.event), ['core.ready', 'playback.snapshot'])
  assert.deepEqual(h.events[1]!.payload, seed(second)); t.mock.timers.reset()
})

test('006：实际manual restart重新协商新instance；旧child事件/回执不得进入新route', async t => {
  const h = harness(t), first = randomUUID(), second = randomUUID(), started = h.supervisor.start()
  h.ready(first); await tick(); h.ports[0]!.reply(seed(first)); await started
  const restart = h.supervisor.restart(), deadline = Date.now() + 500
  while (h.ports.length < 2 && Date.now() < deadline) await tick()
  assert.equal(h.ports.length, 2)
  assert.deepEqual(h.children[1]!.posted[0], { type: 'musicbridge.core.port', playbackEventProtocol: 'compact-v1' })
  h.ready(second); await tick()
  h.ports[0]!.receive({ version: 1, event: 'playback.snapshot', payload: seed(first, 90) })
  h.ports[1]!.reply(seed(second)); await restart
  assert.deepEqual(h.events.map(event => event.event), ['core.ready', 'playback.snapshot', 'core.ready', 'playback.snapshot'])
  assert.deepEqual(h.events[3]!.payload, seed(second))
  const read = h.supervisor.getPlaybackStreamSnapshot().catch(error => error)
  h.ports[1]!.reply(seed(first)); assert.equal((await read).code, 'INVALID_IPC_RESPONSE')
})

test('PRIVATE_PLAY_GUARD_CARRIER：实际Supervisor只转已验证owned guard并隔离旧child半行', async t => {
  const ports:Port[]=[],children:Child[]=[],stdout:Array<(text:string)=>void>=[],written:string[]=[]
  const readOnlyFd=openSync('/dev/null','r'),writeFd=openSync('/dev/null','w')
  let failWrite=false,failedWrites=0
  const supervisor=new main.CoreSupervisor({entryPath:'/synthetic/core.js',cwd:'/synthetic',env:{MUSIC_BRIDGE_COMPACT_PLAYBACK_EVENTS:'0'},requestTimeoutMs:5,startupTimeoutMs:1_000,
    dependencies:{
      writeLocalPlaybackGuard:row=>{
        if(failWrite){
          failWrite=false;assert.throws(()=>writeSync(readOnlyFd,'合成只读FD探针'),{code:'EBADF'})
          assert.equal(writeLocalPlaybackGuardSync(row,readOnlyFd),false);failedWrites++;return
        }
        assert.equal(writeLocalPlaybackGuardSync(row,writeFd),true);written.push(JSON.stringify(row)+'\n')
      },
      createChannel:()=>{const port=new Port();ports.push(port);return{port1:new Port(),port2:port}},
      fork:()=>{
        const listeners:Array<(chunk:{toString():string})=>void>=[]
        const child=Object.assign(new Child(),{stdout:{on(event:'data',listener:(chunk:{toString():string})=>void){assert.equal(event,'data');listeners.push(listener)}}})
        children.push(child);stdout.push(text=>{for(const listener of listeners)listener({toString:()=>text})});return child
      },
    },
  })
  t.after(async()=>{
    const errors:unknown[]=[]
    try{await supervisor.shutdown()}catch(error){errors.push(error)}
    for(const fd of [readOnlyFd,writeFd])try{closeSync(fd)}catch(error){errors.push(error)}
    if(errors.length)throw new AggregateError(errors,'私有guard定向例清理失败')
  })
  const guard={timestamp:'2026-10-14T10:00:00.000Z',level:'info',event:'local_play_request_guard_evidence',schemaVersion:1,component:'controller',diagnosticId:'diag-local-'+'a'.repeat(64),requestFingerprintSha256:'b'.repeat(64),stage:'request-guard',operationStage:'SECOND_FACTS',firstStage:'SECOND_FACTS',phase:'failed',elapsedMs:10,code:'FACTS_CHANGED',errorClass:'LocalSourcePreparationError',httpStatus:409,cancelled:'not-observed',intentMatch:'match',targetMatch:'match',sourceMatch:'mismatch',fenceMatch:'match',snapshotMatch:'match',factsMatch:'mismatch',differenceMask:1}
  const line=JSON.stringify(guard)+'\n',starting=supervisor.start()
  ports[0]!.receive({version:1,event:'core.ready',payload:{state:health}});await starting;await tick()
  // attach完成后才模拟异步stdout，不把注册监听期间当成已owned。
  stdout[0]!(line.slice(0,40));assert.equal(written.length,0);await tick();stdout[0]!(line.slice(40))
  assert.deepEqual(written.map(row=>JSON.parse(row)),[guard]);assert.deepEqual(supervisor.getLocalPlaybackEvidenceSnapshot(),[guard])
  const common={timestamp:guard.timestamp,level:'info',schemaVersion:1,diagnosticId:guard.diagnosticId,currentOwned:true,staleCallback:false}
  const oldRows=[
    {...common,event:'local_playback_evidence',component:'controller',stage:'roon-phase',sessionConfirmed:true,elapsedMs:1,phase:'PLAYING'},
    {...common,event:'local_playback_evidence',component:'controller',stage:'position',sessionConfirmed:true,elapsedMs:1,sampleSequence:1,source:'zone',positionMs:0,positionAdvanced:false},
    {...common,event:'local_playback_media_evidence',component:'gateway',stage:'request',requestSequence:1,method:'GET',routeClass:'local-file',rangeClass:'none'},
    {...common,event:'local_playback_media_evidence',component:'gateway',stage:'truncated',requestSequence:17,method:'GET',routeClass:'local-file',rangeClass:'none',requestLimit:16},
    {...common,event:'local_playback_media_evidence',component:'gateway',stage:'transfer-terminal',requestSequence:1,method:'GET',routeClass:'local-file',rangeClass:'none',outcome:'body-completed',statusCode:200,pipelineBodyBytesObserved:100,observedBytesCapped:false,responseFinished:true,elapsedMs:1,completedPipelineBodyBytes:100},
  ]
  stdout[0]!('普通stdout\n'+JSON.stringify({...guard,url:'https://example.invalid'})+'\n'+oldRows.map(row=>JSON.stringify(row)+'\n').join(''))
  assert.equal(written.length,1);assert.deepEqual(supervisor.getLocalPlaybackEvidenceSnapshot().slice(1),oldRows)
  stdout[0]!(line.slice(0,40))
  const restarting=supervisor.restart(),deadline=Date.now()+500
  while(ports.length<2&&Date.now()<deadline)await tick()
  assert.equal(ports.length,2);ports[1]!.receive({version:1,event:'core.ready',payload:{state:health}});await restarting;await tick()
  stdout[1]!(line);assert.equal(written.length,2);assert.equal(supervisor.getLocalPlaybackEvidenceSnapshot().length,7)
  stdout[0]!(line.slice(40))
  stdout[0]!(line)
  assert.equal(written.length,2);assert.equal(supervisor.getLocalPlaybackEvidenceSnapshot().length,7)
  // 旧五形状仍只按原闭集入ring，不借新sink改变其规则或转发它们。
  stdout[0]!(JSON.stringify(oldRows[0])+'\n');assert.equal(written.length,2);assert.equal(supervisor.getLocalPlaybackEvidenceSnapshot().length,8)
  failWrite=true;assert.doesNotThrow(()=>stdout[1]!(line));assert.equal(failedWrites,1);assert.equal(written.length,2);assert.equal(supervisor.getLocalPlaybackEvidenceSnapshot().length,9);assert.equal(supervisor.status,'ready')
  stdout[1]!(line);assert.deepEqual(written.map(row=>JSON.parse(row)),[guard,guard,guard])
  await supervisor.shutdown();assert.equal(supervisor.status,'stopped');assert.ok(children.every(child=>child.listener===undefined))
  const count=supervisor.getLocalPlaybackEvidenceSnapshot().length;stdout[1]!(line)
  assert.equal(written.length,3);assert.equal(supervisor.getLocalPlaybackEvidenceSnapshot().length,count)
  assert.ok(ports.flatMap(port=>port.sent).every(request=>request.command==='core.shutdown'))
})
