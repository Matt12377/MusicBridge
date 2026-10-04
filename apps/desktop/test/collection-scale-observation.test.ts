import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, chmod, writeFile, symlink, stat } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { nextTick } from 'vue'
import * as contracts from '@music-bridge/contracts'
import { collectionScaleDomExpression, COLLECTION_SCALE_WORKLOADS } from '../e2e/collection-scale-dom-driver.js'
import { createCollectionScaleEvidenceWriter, createCollectionScaleMainProbe, readCollectionScaleProfile, readCollectionScaleProfileWithinRoot, collectionScaleResetRequired, collectionScaleFilterEquivalent, selectCollectionScaleWarmRead, selectCollectionScaleSettingsStatus, createCollectionScaleCoreStreamDrain, waitForCollectionScaleEvidenceDrain } from '../src/main/collection-scale-main-probe.js'
import { installCollectionScaleCoreObserver } from '../src/main/collection-scale-core-observer.js'
import { spawn } from 'node:child_process'
import { syntheticFixtureRoot } from './helpers/synthetic-profile-root.js'
const controlledScaleProfile = (env: NodeJS.ProcessEnv) => readCollectionScaleProfileWithinRoot(env, syntheticFixtureRoot())

test('Core同步sink短写可恢复，固定预算或永久失败后毒化且不再拼新行', () => {
  const source = readFileSync(new URL('../src/main/collection-scale-core-observer.ts', import.meta.url), 'utf8'), sinkSource = source.match(/export function createCollectionScaleCoreEvidenceSink\(\)[\s\S]*?\n\}/u)![0]
  const compiled = transpileModule(sinkSource, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const load = (write: (...args: any[]) => number) => {
    let clock = 0; const result = { exports: {} as any }
    vm.runInNewContext(`(function(exports){${compiled}\n})`, { Buffer, writeSync: write, performance: { now: () => clock }, Atomics: { wait: (_cell: unknown, _index: number, _value: number, timeout: number) => { clock += timeout } } })(result.exports)
    return result.exports.createCollectionScaleCoreEvidenceSink()
  }
  const chunks: Buffer[] = []; let attempts = 0
  const recover = load((_fd, bytes, offset, length) => { attempts++; if (attempts === 2) throw Object.assign(new Error('暂不可写'), { code: 'EAGAIN' }); const n = attempts === 1 ? 7 : length; chunks.push(bytes.subarray(offset, offset + n)); return n })
  recover('原UTF8樱花🌸完整行\n'); assert.equal(Buffer.concat(chunks).toString(), '原UTF8樱花🌸完整行\n'); assert.equal(attempts, 3)
  let limitedCalls = 0
  const limited = load(() => { limitedCalls++; throw Object.assign(new Error('持续背压'), { code: 'EAGAIN' }) })
  assert.throws(() => limited('line\n'), /有界背压预算/u); const count = limitedCalls; assert.ok(count <= 4096); assert.throws(() => limited('另一行\n'), /有界背压预算/u); assert.equal(limitedCalls, count)
  let permanentCalls = 0; const permanentError = Object.assign(new Error('永久失败'), { code: 'EINVAL' })
  const permanent = load(() => { permanentCalls++; if (permanentCalls === 1) return 4; throw permanentError })
  assert.throws(() => permanent('prefix-long\n'), error => error === permanentError); assert.throws(() => permanent('never-append\n'), error => error === permanentError); assert.equal(permanentCalls, 2)
  let oversizedCalls = 0; const oversized = load(() => { oversizedCalls++; return 1 })
  assert.throws(() => oversized('x'.repeat(16 * 1024 * 1024 + 1)), /固定大小预算/u); assert.equal(oversizedCalls, 0)
})
test('Main原Core pipe保留分块UTF8、坏行原bytes和end尾片段，拒绝保存有界且不覆盖', async t => {
  await profile(t)
  const lines: string[] = [], probe = createCollectionScaleMainProbe({ profileReader: controlledScaleProfile, sink: line => lines.push(line) }), stream = new EventEmitter(), child = new EventEmitter() as any
  child.stdout = stream; probe.observeChild(child, '/synthetic-core.js', [])
  const good = Buffer.from('RUST015_EVIDENCE ' + JSON.stringify({ schemaVersion: 1, actor: 'core', pid: 1, sequence: 1, elapsedMs: 0, event: 'test.unicode', data: { text: '樱花🌸' } }) + '\n')
  const emoji = good.indexOf(Buffer.from('🌸')); stream.emit('data', good.subarray(0, emoji + 1)); stream.emit('data', good.subarray(emoji + 1, emoji + 3)); stream.emit('data', good.subarray(emoji + 3))
  assert.ok(lines.includes(good.toString()))
  const invalid = Buffer.concat([Buffer.from('RUST015_EVIDENCE {"broken":"'), Buffer.from([0xff]), Buffer.from('"}\n')])
  stream.emit('data', invalid)
  const tail = Buffer.from('RUST015_EVIDENCE {"unfinished":"樱花🌸')
  stream.emit('data', tail.subarray(0, tail.length - 2)); stream.emit('data', tail.subarray(tail.length - 2)); stream.emit('end'); stream.emit('close')
  const rejected = lines.map(line => JSON.parse(line.slice('RUST015_EVIDENCE '.length))).filter(event => event.event === 'main.coreEvidenceRejected')
  assert.deepEqual(rejected.map(event => event.data.reason), ['INVALID_JSON', 'INCOMPLETE_FRAGMENT'])
  for (const [index, event] of rejected.entries()) { const bytes = [invalid, tail][index]!; assert.equal(event.data.rawBytes, bytes.length); assert.equal(event.data.rawSha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(event.data.rawSaved, true); assert.deepEqual(readFileSync(event.data.rawLinePath), bytes); assert.equal((await stat(event.data.rawLinePath)).mode & 0o777, 0o600) }
  const stream2 = new EventEmitter(), child2 = new EventEmitter() as any; child2.stdout = stream2; probe.observeChild(child2, '/synthetic-core.js', [])
  for (let index = 0; index < 4; index++) stream2.emit('data', Buffer.from('RUST015_EVIDENCE invalid\n'))
  const all = lines.map(line => JSON.parse(line.slice('RUST015_EVIDENCE '.length))).filter(event => event.event === 'main.coreEvidenceRejected')
  assert.deepEqual(all.map(event => event.data.rawSaved), [true, true, true, true, false, false]); assert.ok(all.slice(4).every(event => event.data.rawLinePath === null)); assert.deepEqual(readFileSync(rejected[0].data.rawLinePath), invalid)
})
test('Main转发失败仍保存原行，拒绝文件symlink/wx碰撞不覆盖原目标', async t => {
  const fixture = await profile(t), lines: string[] = [], probe = createCollectionScaleMainProbe({ profileReader: controlledScaleProfile, sink: line => { if (line.includes('"actor":"core"')) throw new Error('受控转发失败'); lines.push(line) } }), stream = new EventEmitter(), child = new EventEmitter() as any
  child.stdout = stream; probe.observeChild(child, '/synthetic-core.js', [])
  const protectedFile = path.join(fixture.directory, 'protected-raw.bin'), firstPath = path.join(fixture.directory, `rust015-core-rejected-${fixture.marker.nonce}-${process.pid}-1.bin`)
  await writeFile(protectedFile, '原目标'); await symlink(protectedFile, firstPath)
  const raw = Buffer.from('RUST015_EVIDENCE ' + JSON.stringify({ schemaVersion: 1, actor: 'core', pid: 1, sequence: 1, elapsedMs: 0, event: 'test.forward', data: {} }) + '\n')
  stream.emit('data', raw)
  const rejected = lines.map(line => JSON.parse(line.slice('RUST015_EVIDENCE '.length))).find(event => event.event === 'main.coreEvidenceRejected')
  assert.equal(rejected.data.reason, 'FORWARD_FAILED'); assert.equal(rejected.data.rawSaved, false); assert.equal(rejected.data.rawLinePath, null); assert.equal(rejected.data.rawSha256, createHash('sha256').update(raw).digest('hex')); assert.equal(readFileSync(protectedFile, 'utf8'), '原目标')
})

test('真实非阻塞pipe慢消费仍完整写完Core同步证据，不吞EAGAIN或拼接后续行', async t => {
  const directory = await mkdtemp(path.join(syntheticFixtureRoot().directory, 'musicbridge-ui-diagnostics-rust015-b-pipe-'))
  const source = readFileSync(new URL('../src/main/collection-scale-core-observer.ts', import.meta.url), 'utf8'), sink = source.match(/export function createCollectionScaleCoreEvidenceSink\(\)[\s\S]*?\n\}/u)![0]
  const compiled = transpileModule(`import { writeSync } from 'node:fs'\n${sink}`, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const lines = Array.from({ length: 20 }, (_, index) => 'RUST015_EVIDENCE ' + JSON.stringify({ schemaVersion: 1, actor: 'core', pid: 1, sequence: index + 1, elapsedMs: index, event: 'test.pipe', data: { synthetic: '樱花🌸'.repeat(6000) } }) + '\n')
  const file = path.join(directory, 'pipe.cjs')
  await writeFile(file, compiled + `\nconst sink=exports.createCollectionScaleCoreEvidenceSink(); require('node:fs').writeSync(2,'READY\\n'); const errors=[]; for(const line of ${JSON.stringify(lines)}) { try{sink(line)}catch(error){errors.push(error.code??error.message)} } require('node:fs').writeSync(2,JSON.stringify(errors)+'\\n');`, { mode: 0o600 })
  const child = spawn('python3', ['-c', 'import fcntl,os,sys; fcntl.fcntl(1,fcntl.F_SETFL,fcntl.fcntl(1,fcntl.F_GETFL)|os.O_NONBLOCK); os.execv(sys.argv[1],[sys.argv[1],sys.argv[2]])', process.execPath, file], { stdio: ['ignore', 'pipe', 'pipe'] }), chunks: Buffer[] = [], errors: Buffer[] = []
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stdout.pause()
  child.stderr.on('data', chunk => { errors.push(chunk); if (chunk.toString().includes('READY')) setTimeout(() => child.stdout.resume(), 150) })
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  const bytes = Buffer.concat(chunks), trace = Buffer.concat(errors).toString()
  await writeFile(path.join(directory, 'raw.bin'), bytes); await writeFile(path.join(directory, 'write-trace.log'), trace)
  assert.equal(exit, 0); assert.equal(trace.trim().split('\n').at(-1), '[]'); assert.equal(bytes.toString(), lines.join(''))
})

test('规模证据写入异常不会成为产品失败，单调sequence与本地clock独立', () => {
  const lines: string[] = [], emit = createCollectionScaleEvidenceWriter('main', line => { lines.push(line); throw new Error('诊断失败') })
  emit('first'); emit('second')
  const events = lines.map(line => JSON.parse(line.slice('RUST015_EVIDENCE '.length)))
  assert.deepEqual(events.map(value => value.sequence), [1, 2]); assert.ok(events[1].elapsedMs >= events[0].elapsedMs)
})
test('固定DOM表达式闭集，只操作原控件，不获得业务API或store', () => {
  const actionId = randomUUID()
  for (const workload of Object.keys(COLLECTION_SCALE_WORKLOADS)) {
    const expression = collectionScaleDomExpression('workload', { kind: 'rust015-dom-action', actionId, operation: 'workload', workload })
    assert.ok(expression.includes('dispatchEvent')); assert.ok(expression.includes('筛选')); assert.equal(expression.includes('window.musicBridge'), false); assert.equal(expression.includes('store.'), false)
  }
  for (const [operation, action] of [['direct-api', undefined], ['workload', { kind: 'rust015-dom-action', actionId, operation: 'workload', workload: 'unbounded' }], ['readonly-on', { kind: 'rust015-dom-action', actionId, operation: 'readonly-off' }]] as any[]) assert.throws(() => collectionScaleDomExpression(operation, action), /参数无效/u)
})
test('实际无筛选UI缺少清除时只读省略动作，有筛选却缺按钮须拒绝', () => {
  assert.equal(collectionScaleResetRequired({ filterClearVisible: false }, {}), false)
  assert.equal(collectionScaleResetRequired({ filterClearVisible: false }, { query: '', brand: '' }), false)
  assert.equal(collectionScaleResetRequired({ filterClearVisible: true }, { brand: 'RUST015品牌甲' }), true)
  assert.throws(() => collectionScaleResetRequired({ filterClearVisible: false }, { query: '%_' }), /并非无筛选/u)
  assert.throws(() => collectionScaleResetRequired({ filterClearVisible: false }, undefined), /并非无筛选/u)
})
test('真实jsdom六筛选保留两次select原读取，受控Main证据只接受最终submit完整paint', async () => {
  const require = createRequire(import.meta.url), { JSDOM } = require('../../../node_modules/.pnpm/jsdom@24.1.3/node_modules/jsdom')
  const dom = new JSDOM('<div id="collection-panel-tapes"><input form="collection-filters" name="query"><form id="collection-filters"><input name="brand"><select name="decade"><option value=""></option><option value="1990"></option></select><select name="stockState"><option value=""></option><option value="blank"></option></select><button type="submit">筛选</button></form></div>', { url: 'https://musicbridge.invalid' })
  const window = dom.window, events: any[] = [], frames: FrameRequestCallback[] = [], pending: (() => void)[] = []
  const context = vm.createContext({ document: window.document, Element: window.Element, window: { musicBridge: { listCollection: (_page: unknown, _filter: unknown) => new Promise(resolve => pending.push(() => resolve({ items: [], total: 0, offset: 0, limit: 24 }))) } }, performance, crypto: { randomUUID }, structuredClone, queueMicrotask, requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length }, console: { info: (line: string) => events.push(JSON.parse(line.slice('RUST015_EVIDENCE '.length))) }, __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__: true })
  const load = (file: string, resolve: (name: string) => unknown): any => {
    const compiled = transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, result = { exports: {} }
    vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context)(resolve, result, result.exports); return result.exports
  }
  const observation = load('../src/renderer/src/collection-scale-observation.ts', () => ({ nextTick })), inventory = load('../src/renderer/src/composables/useCollection.ts', name => name === 'vue' ? require('vue') : observation).useCollection()
  // 直接编译原组件applyFilter；控件事件仍由真实DOM触发，不跳过任何原select change。
  const source = readFileSync(new URL('../src/renderer/src/components/collection/CollectionView.vue', import.meta.url), 'utf8'), applySource = source.match(/function applyFilter\(\): void \{[\s\S]*?\n\}/u)![0]
  const draft = { value: { query: '', brand: '', decade: '', stockState: '' } }
  Object.assign(context, { filterDraft: draft, filter: inventory.filter, inventory })
  const applyFilter = vm.runInContext(transpileModule(`${applySource}\napplyFilter`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context)
  for (const name of ['query', 'brand', 'decade', 'stockState']) {
    const control = window.document.querySelector(`[name="${name}"]`)
    control.addEventListener(name === 'query' || name === 'brand' ? 'input' : 'change', () => { (draft.value as any)[name] = control.value; if (name === 'decade' || name === 'stockState') applyFilter() })
  }
  const form = window.document.querySelector('form'); form.addEventListener('submit', (event: any) => { event.preventDefault(); applyFilter() })
  const flush = async () => { pending.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve)); while (frames.length) frames.shift()!(0) }
  for (const [workload, expected] of Object.entries(COLLECTION_SCALE_WORKLOADS)) {
    const action = { kind: 'rust015-dom-action', actionId: randomUUID(), operation: 'workload', workload, iteration: 0, mode: 'node' }
    window.document.dispatchEvent(new window.CustomEvent('musicbridge:collection-scale-action', { detail: action }))
    for (const name of ['query', 'brand', 'decade', 'stockState']) { const control = window.document.querySelector(`[name="${name}"]`); control.value = String((expected as any)[name] ?? ''); control.dispatchEvent(new window.Event(name === 'query' || name === 'brand' ? 'input' : 'change', { bubbles: true })) }
    await flush() // 两次select读可先paint；原submit尚未发生。
    const before = events.filter(event => event.data.actionId === action.actionId)
    assert.equal(before.filter(event => event.event === 'renderer.begin').length, 2); assert.equal(before.filter(event => event.event === 'renderer.paint').length, 1)
    assert.equal(selectCollectionScaleWarmRead(action.actionId, workload as keyof typeof COLLECTION_SCALE_WORKLOADS, { renderer: before, main: [] }), undefined)
    form.querySelector('button').click(); await flush()
    const own = events.filter(event => event.data.actionId === action.actionId), reads = own.filter(event => event.event === 'renderer.begin'), submit = own.find(event => event.event === 'renderer.trigger' && event.data.domEvent === 'submit')
    assert.equal(reads.length, 3); assert.deepEqual(reads.map(event => event.data.catalogOrdinal), [1, 2, 3])
    assert.equal(reads[2].data.triggerSequence, submit.sequence); assert.equal(reads[2].data.triggerDomEvent, 'submit')
    assert.deepEqual(JSON.parse(JSON.stringify(reads[2].data.request.filter)), { query: '', brand: '', ...expected })
    const paint = own.filter(event => event.event === 'renderer.paint').at(-1); assert.equal(paint.data.observationId, reads[2].data.observationId); assert.equal(paint.data.generation, reads[2].data.generation)
    // 受控Main事件只用于验证选样拒绝边界；真实Main owner旁路另有原listener测试。
    const main: { event: string; data: any }[] = reads.flatMap((read, index) => {
      const invokeId = `ipc-test-${index + 1}`, requestId = randomUUID(), result = own.find(event => event.event === 'renderer.invokeReply' && event.data.observationId === read.data.observationId).data.result
      const fields = { actionId: action.actionId, invokeId, catalogOrdinal: index + 1 }
      return [{ event: 'main.ipcRequest', data: { ...fields, channel: 'collection:list', args: [read.data.request.page, read.data.request.filter] } }, { event: 'main.request', data: { ...fields, request: { id: requestId, command: 'collection.list', payload: read.data.request } } }, { event: 'main.ipcReply', data: { ...fields, channel: 'collection:list', result } }, { event: 'main.response', data: { ...fields, requestId, reply: { ok: true, result } } }]
    })
    const evidence = { renderer: own, main }, selected = selectCollectionScaleWarmRead(action.actionId, workload as keyof typeof COLLECTION_SCALE_WORKLOADS, evidence)!
    assert.equal(selected.selection.observationId, reads[2].data.observationId); assert.equal(selected.selection.catalogOrdinal, 3); assert.equal(selected.selection.invokeId, 'ipc-test-3'); assert.equal(selected.selection.finalSubmitRendererSequence, submit.sequence); assert.equal(selected.selection.paintRendererSequence, paint.sequence)
    const wrongTarget = structuredClone(evidence); wrongTarget.renderer.find(event => event.sequence === submit.sequence)!.data.target = 'BUTTON'
    assert.throws(() => selectCollectionScaleWarmRead(action.actionId, workload as keyof typeof COLLECTION_SCALE_WORKLOADS, wrongTarget), /原FORM/u)
    assert.equal(selectCollectionScaleWarmRead(action.actionId, workload as keyof typeof COLLECTION_SCALE_WORKLOADS, { ...evidence, renderer: own.filter(event => event !== paint) }), undefined)
    const wrongTail = structuredClone(evidence); wrongTail.renderer.push({ sequence: paint.sequence + 1, event: 'renderer.begin', data: { ...reads[2].data, observationId: 'wrong-tail', generation: reads[2].data.generation + 1, triggerSequence: paint.sequence + 1, triggerDomEvent: 'change', catalogOrdinal: 4 } })
    assert.throws(() => selectCollectionScaleWarmRead(action.actionId, workload as keyof typeof COLLECTION_SCALE_WORKLOADS, wrongTail), /唯一最新/u)
    const wrongOwner = structuredClone(evidence); wrongOwner.main.find(event => event.event === 'main.request' && event.data.catalogOrdinal === 3)!.data.invokeId = 'wrong-owner'
    assert.equal(selectCollectionScaleWarmRead(action.actionId, workload as keyof typeof COLLECTION_SCALE_WORKLOADS, wrongOwner), undefined)
    const wrongOrdinal = structuredClone(evidence); wrongOrdinal.main.find(event => event.event === 'main.ipcRequest' && event.data.catalogOrdinal === 3)!.data.catalogOrdinal = 2
    assert.throws(() => selectCollectionScaleWarmRead(action.actionId, workload as keyof typeof COLLECTION_SCALE_WORKLOADS, wrongOrdinal), /次序或参数/u)
    const wrongFilter = structuredClone(evidence)
    for (const event of wrongFilter.renderer.filter(event => event.data.observationId === reads[2].data.observationId)) event.data.request.filter = { query: '非空错尾', brand: '' }
    wrongFilter.main.find(event => event.event === 'main.ipcRequest' && event.data.catalogOrdinal === 3)!.data.args[1] = { query: '非空错尾', brand: '' }
    wrongFilter.main.find(event => event.event === 'main.request' && event.data.catalogOrdinal === 3)!.data.request.payload.filter = { query: '非空错尾', brand: '' }
    assert.throws(() => selectCollectionScaleWarmRead(action.actionId, workload as keyof typeof COLLECTION_SCALE_WORKLOADS, wrongFilter), /工作量参数/u)
  }
  dom.window.close()
})
test('空筛选观察等价只接受原query/brand严格空字符串，不吞非空或其它空字段', () => {
  for (const [actual, expected] of [[{ query: '', brand: '' }, {}], [{ query: '%_', brand: '' }, { query: '%_' }], [{ query: '', brand: 'RUST015品牌甲', stockState: 'blank' }, { brand: 'RUST015品牌甲', stockState: 'blank' }]]) assert.equal(collectionScaleFilterEquivalent(actual, expected), true)
  for (const actual of [{ query: ' ' }, { query: '非空' }, { brand: '非空' }, { query: null }, { stockState: '' }, { decade: '' }, { unknown: '' }, undefined]) assert.equal(collectionScaleFilterEquivalent(actual, {}), false)
})
test('原IPC被动owner关联跨await公开请求，后台limit1不占catalog次序', async t => {
  await profile(t)
  const lines: string[] = [], probe = createCollectionScaleMainProbe({ profileReader: controlledScaleProfile, sink: line => lines.push(line) }), port = new EventEmitter() as any
  port.postMessage = (_value: unknown) => {}; probe.observePublicPort(port)
  const requests: any[] = []
  const listener = probe.observeIpc({ channel: 'collection:list', listener: async (_event: unknown, page: any, filter: any) => {
    await Promise.resolve(); const request = { version: 1, id: randomUUID(), command: 'collection.list', payload: { page, filter } }; requests.push(request); port.postMessage(request); port.emit('message', { data: { version: 1, id: request.id, ok: true, result: { items: [], total: 0, hasMore: false, ...page } } }); return { items: [], total: 0, hasMore: false, ...page }
  }, trustedSender: () => ({ webContentsId: 1, rendererPid: 2, frameUrl: 'musicbridge://app/index.html', trusted: true }) })
  await listener({}, { offset: 0, limit: 24 }, { query: '', brand: '' }); await listener({}, { offset: 0, limit: 1 }, { stockState: 'needs-review' })
  const events = lines.map(line => JSON.parse(line.slice('RUST015_EVIDENCE '.length))), ipc = events.filter(event => event.event === 'main.ipcRequest'), publicRequests = events.filter(event => event.event === 'main.request')
  assert.equal(publicRequests.length, 2); assert.deepEqual(publicRequests.map(event => event.data.invokeId), ipc.map(event => event.data.invokeId)); assert.ok(publicRequests.every(event => event.data.invokeId !== undefined))
  assert.deepEqual(requests.map(request => Object.keys(request)), [['version', 'id', 'command', 'payload'], ['version', 'id', 'command', 'payload']])
  // 受控窗口仅进入第一个Main动作再明确中止；不伪造完整App流程或ProbeComplete。
  const window = { webContents: { executeJavaScript: async () => {
    const action = lines.map(line => JSON.parse(line.slice('RUST015_EVIDENCE '.length))).find(event => event.event === 'main.domAction')
    if (!action) return { readyState: 'complete', frameUrl: 'musicbridge://app/index.html', errorCount: 0, rows: [] }
    await Promise.all([listener({}, { offset: 0, limit: 24 }, { query: '', brand: '' }), listener({}, { offset: 0, limit: 1 }, { stockState: 'needs-review' }), listener({}, { offset: 0, limit: 24 }, { query: '%_', brand: '' })])
    throw new Error('受控Main动作测试到此中止')
  } } } as any
  await assert.rejects(probe.runWindowProbe(window), /受控Main动作/u)
  const complete = lines.map(line => JSON.parse(line.slice('RUST015_EVIDENCE '.length))), own = complete.find(event => event.event === 'main.domAction').data.actionId
  const ownIpc = complete.filter(event => event.event === 'main.ipcRequest' && event.data.actionId === own), ownPublic = complete.filter(event => event.event === 'main.request' && event.data.actionId === own)
  assert.deepEqual(ownIpc.map(event => event.data.catalogOrdinal), [1, null, 2]); assert.deepEqual(ownPublic.map(event => event.data.catalogOrdinal), [1, null, 2]); assert.deepEqual(ownPublic.map(event => event.data.invokeId), ownIpc.map(event => event.data.invokeId))
  assert.equal(complete.some(event => event.event === 'main.rendererProbeComplete'), false)
})
test('select原change查询暂禁用筛选时有界等待，只在原按钮可用后实际click', async () => {
  const clicks: string[] = [], changes: string[] = []
  class Element {
    textContent = ''; childNodes: unknown[] = []; disabled = false
    getClientRects() { return [{}] } matches(selector: string) { return selector === ':disabled' && this.disabled } scrollIntoView() {}
    querySelector(_selector: string): any { return null } querySelectorAll(_selector: string): any[] { return [] }
    click() { assert.equal(this.disabled, false); clicks.push(this.textContent) }
  }
  const submit = new Element(); submit.textContent = '筛选'
  class Input extends Element { readOnly = false; value = ''; dispatchEvent(_event: unknown) { return true } }
  class Select extends Element { value = ''; options = [{ value: '' }, { value: '1990' }, { value: 'blank' }]; dispatchEvent(event: any) { if (event.type === 'change') { changes.push(this.value); submit.disabled = true; setTimeout(() => { submit.disabled = false }, 40) } return true } }
  const label = (name: string, control: Input | Select) => { const value = new Element(); value.querySelector = selector => selector === '.filter-label' ? { textContent: name } : null; value.querySelectorAll = selector => selector === 'input,select' ? [control] : []; return value }
  const form = new Element(), root = new Element(), controls = [label('品牌', new Input()), label('年代', new Select()), label('收藏状态', new Select())], keyword = label('关键词', new Input())
  form.querySelectorAll = selector => selector === 'label' ? controls : selector === 'button' ? [submit] : []
  root.querySelectorAll = selector => selector === 'label' ? [keyword] : []
  const document = { readyState: 'complete', dispatchEvent() {}, querySelectorAll: (selector: string) => selector === '#collection-filters' ? [form] : selector === '#collection-panel-tapes' ? [root] : selector === '#collection-filters button' ? [submit] : [], querySelector: (selector: string) => selector === '#collection-panel-tapes' ? root : null }
  const Event = class { constructor(public type: string, _options: unknown) {} }
  const expression = collectionScaleDomExpression('workload', { kind: 'rust015-dom-action', actionId: randomUUID(), operation: 'workload', workload: 'decade', iteration: 0, mode: 'node' })
  const result = await vm.runInNewContext(expression, { document, performance, setTimeout, Element, HTMLInputElement: Input, HTMLSelectElement: Select, InputEvent: Event, Event, CustomEvent: Event, Node: { TEXT_NODE: 3 }, location: { href: 'musicbridge://app/index.html' }, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), window: new Proxy({}, { get() { throw new Error('禁止窗口业务API') } }) })
  assert.deepEqual(changes, ['1990', '']); assert.deepEqual(clicks, ['筛选']); assert.equal(result.filterClearVisible, false)
})
test('真实jsdom checkbox.click激活的可信input/change保留固定action UUID直到原setEnabled paint', async () => {
  const require = createRequire(import.meta.url), { JSDOM } = require('../../../node_modules/.pnpm/jsdom@24.1.3/node_modules/jsdom')
  const dom = new JSDOM('<input type="checkbox" aria-label="Rust 收藏查询"><form id="collection-filters"><button type="submit">筛选</button></form>', { url: 'https://musicbridge.invalid' })
  const window = dom.window, events: any[] = [], frames: FrameRequestCallback[] = [], modules: Record<string, any> = {}
  const context = vm.createContext({ document: window.document, Element: window.Element, performance, crypto: { randomUUID }, structuredClone, queueMicrotask, requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length }, console: { info: (line: string) => events.push(JSON.parse(line.slice('RUST015_EVIDENCE '.length))) }, __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__: true })
  const load = (file: string, resolve: (name: string) => unknown): any => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8'), compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, result = { exports: {} }
    vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context)(resolve, result, result.exports); return result.exports
  }
  modules.observation = load('../src/renderer/src/collection-scale-observation.ts', () => ({ nextTick }))
  modules.preference = load('../src/renderer/src/components/settings/collection-readonly-preference.ts', name => name === 'vue' ? require('vue') : name === '@music-bridge/contracts' ? contracts : modules.observation)
  const off = { schemaVersion: 1, enabled: false, mode: 'node', state: 'off' }, ready = { schemaVersion: 1, enabled: true, mode: 'rust', state: 'ready' }, calls: boolean[] = []
  const preference = modules.preference.createCollectionReadonlyPreference({ getCollectionReadonlySettings: async () => ready, setCollectionReadonlyEnabled: async (enabled: boolean) => { calls.push(enabled); return enabled ? ready : off } })
  const checkbox = window.document.querySelector('input'), activation: [string, boolean][] = []
  for (const name of ['click', 'input', 'change']) checkbox.addEventListener(name, (event: any) => activation.push([name, event.isTrusted]))
  checkbox.addEventListener('change', (event: any) => { void preference.select(event.target.checked) })
  const action = { kind: 'rust015-dom-action', actionId: randomUUID(), operation: 'readonly-on' }
  window.document.dispatchEvent(new window.CustomEvent('musicbridge:collection-scale-action', { detail: action })); checkbox.click()
  await new Promise(resolve => setImmediate(resolve)); while (frames.length) frames.shift()!(0)
  assert.deepEqual(activation, [['click', false], ['input', true], ['change', true]]); assert.deepEqual(calls, [true])
  const own = events.filter(event => ['renderer.begin', 'renderer.invokeReply', 'renderer.commit', 'renderer.nextTick', 'renderer.paint'].includes(event.event) && event.data.request?.operation === 'setEnabled')
  assert.deepEqual(own.map(event => event.event), ['renderer.begin', 'renderer.invokeReply', 'renderer.commit', 'renderer.nextTick', 'renderer.paint']); assert.ok(own.every(event => event.data.actionId === action.actionId))
  assert.deepEqual(events.filter(event => event.event === 'renderer.trigger').slice(0, 3).map(event => event.data.isTrusted), [false, true, true])
  // 原form.submit由按钮激活产生，target为form；这仍是同一固定按钮激活链。
  const form = window.document.querySelector('form'), button = form.querySelector('button'), formAction = { kind: 'rust015-dom-action', actionId: randomUUID(), operation: 'workload', workload: 'all', mode: 'node', iteration: 0 }
  form.addEventListener('submit', (event: any) => { event.preventDefault(); const observed = modules.observation.beginCollectionScaleRead('catalog', 1, { page: { offset: 0, limit: 24 }, filter: {} }); modules.observation.finishCollectionScaleRead(observed, true, { total: 0 }) })
  window.document.dispatchEvent(new window.CustomEvent('musicbridge:collection-scale-action', { detail: formAction })); button.click(); await new Promise(resolve => setImmediate(resolve)); while (frames.length) frames.shift()!(0)
  const catalogPaint = events.find(event => event.event === 'renderer.paint' && event.data.layer === 'catalog'); assert.equal(catalogPaint.data.actionId, formAction.actionId)
  const submitEvent = events.find(event => event.event === 'renderer.trigger' && event.data.domEvent === 'submit'); assert.equal(submitEvent.data.isTrusted, true); assert.equal(submitEvent.data.actionId, formAction.actionId)
  preference.close(); dom.window.close()
})
async function profile(t: test.TestContext) {
  const directory = await mkdtemp(path.join(syntheticFixtureRoot().directory, 'musicbridge-ui-diagnostics-rust015-b-test-')); await chmod(directory, 0o700)
  const seed = Buffer.from('{}\n'), receipt = path.join(directory, 'seed.json'); await writeFile(receipt, seed, { mode: 0o600 })
  const marker = { schemaVersion: 1, kind: 'rust015-synthetic-profile', nonce: randomUUID(), modelCount: 0, seedReceipt: { path: receipt, sha256: createHash('sha256').update(seed).digest('hex') } }
  await writeFile(path.join(directory, 'rust015-profile.json'), JSON.stringify(marker), { mode: 0o600 })
  const prior = { ...process.env }, names = ['__MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__', '__MUSIC_BRIDGE_COLLECTION_SCALE_MODELS__']
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, names[0]!, { configurable: true, value: true }); Object.defineProperty(globalThis, names[1]!, { configurable: true, value: 0 })
  process.env.MUSIC_BRIDGE_UI_E2E = '1'; process.env.MUSIC_BRIDGE_UI_E2E_OFFLINE = '1'; process.env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR = directory; delete process.env.MUSIC_BRIDGE_STARTUP_TEST
  t.after(() => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(prior, key)) delete process.env[key]; Object.assign(process.env, prior); names.forEach((name, index) => { if (descriptors[index]) Object.defineProperty(globalThis, name, descriptors[index]!); else Reflect.deleteProperty(globalThis, name) }) })
  return { directory, marker }
}
test('RUST016 受控profileReader必须由Main诊断factory显式调用一次', async t => {
  const fixture = await profile(t)
  let calls = 0
  const options = {
    sink: (_line: string) => {},
    profileReader: (env: NodeJS.ProcessEnv) => {
      calls++
      assert.equal(env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR, fixture.directory)
      return controlledScaleProfile(env)
    },
  } as Parameters<typeof createCollectionScaleMainProbe>[0] & { profileReader(env: NodeJS.ProcessEnv): ReturnType<typeof readCollectionScaleProfile> }
  createCollectionScaleMainProbe(options)
  assert.equal(calls, 1, 'Main诊断factory必须消费受控reader，不能忽略后仍走正式路径。')
})
test('RUST016 受控profileReader拒绝必须传播，不能悄悄回到正式reader', async t => {
  await profile(t)
  const options = {
    sink: (_line: string) => {},
    profileReader: (_env: NodeJS.ProcessEnv): ReturnType<typeof readCollectionScaleProfile> => { throw new Error('受控可信根拒绝') },
  } as Parameters<typeof createCollectionScaleMainProbe>[0] & { profileReader(env: NodeJS.ProcessEnv): ReturnType<typeof readCollectionScaleProfile> }
  assert.throws(() => createCollectionScaleMainProbe(options), /受控可信根拒绝/u)
})
/** 受控Main窗口/原listener旁路测试；不作为真实App或DOM验收证据。 */
async function controlledColdWindow(t: test.TestContext, options: { delayStatus?: boolean; background?: 'resolve' | 'reject' | 'missing'; mainClaim?: boolean; afterBarrier?: () => void } = {}) {
  const fixture = await profile(t), datasetId = randomUUID()
  await writeFile(path.join(fixture.directory, 'rust015-completed.json'), JSON.stringify({ schemaVersion: 1, kind: 'rust015-completed-profile', nonce: fixture.marker.nonce, modelCount: 0, datasetId, commandIds: [], outboxIds: [], policyModelId: null, policyRevision: null }), { mode: 0o600 })
  const events: any[] = [], probe = createCollectionScaleMainProbe({ profileReader: controlledScaleProfile, sink: line => events.push(JSON.parse(line.slice('RUST015_EVIDENCE '.length))) }), web = new EventEmitter() as any
  web.getOSProcessId = () => 71
  const window = { webContents: web } as any; probe.observeRenderer(window)
  const publicPort = new EventEmitter() as any, controlPort = new EventEmitter() as any
  publicPort.postMessage = () => {}; controlPort.postMessage = () => {}; probe.observePublicPort(publicPort); probe.observeControlPort(controlPort)
  const contextId = randomUUID(); publicPort.postMessage({ version: 1, id: contextId, command: 'commandOutbox.context', payload: {} }); publicPort.emit('message', { data: { version: 1, id: contextId, ok: true, result: { datasetId } } })
  if (options.mainClaim) publicPort.postMessage({ version: 1, id: randomUUID(), command: 'recordingPrintWorker.claim', payload: { workerId: randomUUID() } })
  let enabled = true, sequence = 0, observation = 0, catalogGeneration = 0, closeCount = 0, handled: string | undefined, backgroundFinished = false, delayedFinished = false
  const state: any = { filterClearVisible: false, frameUrl: 'musicbridge://app/index.html', readyState: 'complete', total: 0, page: '1 / 1', rows: [], detail: null, readonlySettings: null, dialog: false, inventoryLoading: false, errorCount: 0 }
  const status = () => ({ schemaVersion: 1, enabled, mode: enabled ? 'rust' : 'node', state: enabled ? 'ready' : 'off' })
  const sender = () => ({ webContentsId: 1, rendererPid: 71, frameUrl: 'musicbridge://app/index.html', trusted: true as const })
  const statusIpc = probe.observeIpc({ channel: 'collection:readonly-settings', trustedSender: sender, listener: async () => {
    const request = { schemaVersion: 1, generationNonce: fixture.marker.nonce, requestId: randomUUID(), type: 'status' }
    controlPort.postMessage(request); controlPort.emit('message', { data: { ...request, ok: true, status: status() } }); return status()
  } })
  const enableIpc = probe.observeIpc({ channel: 'collection:set-readonly-enabled', trustedSender: sender, listener: async (_event: unknown, value: boolean) => { enabled = value; return status() } })
  const listIpc = probe.observeIpc({ channel: 'collection:list', trustedSender: sender, listener: async (_event: unknown, page: any, filter: any) => {
    const request = { version: 1, id: randomUUID(), command: 'collection.list', payload: { page, filter } }, result = { items: [], total: 0, hasMore: false, ...page }
    publicPort.postMessage(request)
    if (page.limit === 1) {
      if (options.background === 'missing') await new Promise(() => {})
      await new Promise(resolve => setTimeout(resolve, 45))
      if (options.background === 'reject') { publicPort.emit('message', { data: { version: 1, id: request.id, ok: false, error: { code: 'INTERNAL_ERROR', message: '受控关闭竞态' } } }); backgroundFinished = true; throw new Error('受控原后台拒绝') }
      // 第一个后台原请求返回时新建第二个，证明drain不能冻结开始时的ID集合。
      if (filter.stockState === 'needs-review') void listIpc({}, page, { query: '受控后续原读取' }).catch(() => {})
      else backgroundFinished = true
    }
    publicPort.emit('message', { data: { version: 1, id: request.id, ok: true, result } }); return result
  } })
  const send = (event: string, data: any) => web.emit('console-message', {}, 1, 'RUST015_EVIDENCE ' + JSON.stringify({ schemaVersion: 1, actor: 'renderer', pid: 71, sequence: ++sequence, elapsedMs: sequence, event, data }))
  const read = (action: any, layer: string, generation: number, request: any) => {
    const fields = { actionId: action.actionId, observationId: `controlled-${++observation}`, layer, generation, request, catalogOrdinal: layer === 'catalog' ? 1 : null, triggerSequence: null, triggerDomEvent: null }
    send('renderer.begin', { ...fields, action: { kind: 'rust015-dom-action', ...action } }); return fields
  }
  const finish = (fields: any, result: any) => { send('renderer.invokeReply', { ...fields, result }); send('renderer.commit', { ...fields, result }); send('renderer.nextTick', fields); send('renderer.paint', fields) }
  web.executeJavaScript = async (expression: string) => {
    const action = events.filter(value => value.event === 'main.domAction').at(-1)?.data
    if (action && action.actionId !== handled) {
      handled = action.actionId
      if (action.operation === 'settings-open') {
        state.readonlySettings = { enabled: false, mode: 'node', state: 'off' }
        const fields = read(action, 'control', 1, { operation: 'status' }), result = await statusIpc({})
        if (options.delayStatus && !delayedFinished) setTimeout(() => { state.readonlySettings = { enabled: result.enabled, mode: result.mode, state: result.state }; finish(fields, result); delayedFinished = true }, 60)
        else { state.readonlySettings = { enabled: result.enabled, mode: result.mode, state: result.state }; finish(fields, result) }
      } else if (action.operation === 'readonly-on' || action.operation === 'readonly-off') {
        const fields = read(action, 'control', 2, { operation: 'setEnabled', enabled: action.operation === 'readonly-on' }), result = await enableIpc({}, action.operation === 'readonly-on')
        state.readonlySettings = { enabled: result.enabled, mode: result.mode, state: result.state }; finish(fields, result)
      } else if (action.operation === 'refresh') {
        const fields = read(action, 'refresh', 1, {}); finish(fields, { refreshed: true, settings: status() })
      } else {
        if (action.operation === 'settings-close') { state.readonlySettings = null; closeCount++ }
        const page = { offset: 0, limit: 24 }, filter = { query: '', brand: '' }, fields = read(action, 'catalog', ++catalogGeneration, { page, filter })
        finish(fields, await listIpc({}, page, filter))
        if (options.background && closeCount === 3) { void listIpc({}, { offset: 0, limit: 1 }, { stockState: 'needs-review' }).catch(() => {}); closeCount++ }
      }
    }
    if (expression.includes('await Promise.resolve();await new Promise(resolve=>requestAnimationFrame')) options.afterBarrier?.()
    return structuredClone(state)
  }
  return { probe, window, events, backgroundFinished: () => backgroundFinished, delayedFinished: () => delayedFinished }
}
test('冷启设置页必须等原status最新commit/tick/paint，不把初始默认off当作settled', async t => {
  const fixture = await controlledColdWindow(t, { delayStatus: true })
  await fixture.probe.runWindowProbe(fixture.window)
  const firstAction = fixture.events.find(value => value.event === 'main.domAction' && value.data.operation === 'settings-open').data.actionId
  const settled = fixture.events.find(value => value.event === 'main.domSettled' && value.data.actionId === firstAction)
  assert.deepEqual(settled.data.snapshot.readonlySettings, { enabled: true, mode: 'rust', state: 'ready' })
  assert.equal(fixture.delayedFinished(), true); assert.equal(typeof settled.data.settingsStatusSelection?.paintRendererSequence, 'number')
})
test('最终原catalog paint后动态等待所有原UI后台IPC，后续新请求也收齐再Complete', async t => {
  const fixture = await controlledColdWindow(t, { background: 'resolve', mainClaim: true })
  await fixture.probe.runWindowProbe(fixture.window)
  assert.equal(fixture.backgroundFinished(), true)
  const drained = fixture.events.find(value => value.event === 'main.rendererIpcDrained'), requests = fixture.events.filter(value => value.event === 'main.ipcRequest'), replies = fixture.events.filter(value => value.event === 'main.ipcReply')
  assert.deepEqual(drained?.data, { scope: 'before-original-quit', pendingCount: 0, requestCount: requests.length, replyCount: replies.length, rejectedCount: 0 })
  assert.ok(drained.sequence < fixture.events.find(value => value.event === 'main.rendererProbeComplete').sequence)
  const claim = fixture.events.find(value => value.event === 'main.request' && value.data.request.command === 'recordingPrintWorker.claim'); assert.equal(claim.data.invokeId, null)
  assert.equal(fixture.events.some(value => value.event === 'main.response' && value.data.requestId === claim.data.request.id), false)
})
test('最终原后台IPC拒绝不能被catalog paint或Completed洗成通过', async t => {
  const fixture = await controlledColdWindow(t, { background: 'reject' })
  await assert.rejects(fixture.probe.runWindowProbe(fixture.window), /原UI.*拒绝/u)
  assert.equal(fixture.events.some(value => value.event === 'main.rendererProbeComplete' || value.event === 'main.rendererIpcDrained'), false)
})
test('退出收口缺少原后台回执会耗尽固定预算并失败，不能计为零pending', async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'performance')!, native = performance; let extra = 0
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => native.now() + extra } }); t.after(() => Object.defineProperty(globalThis, 'performance', prior))
  const fixture = await controlledColdWindow(t, { background: 'missing', afterBarrier: () => { extra = 30_001 } })
  await assert.rejects(fixture.probe.runWindowProbe(fixture.window), /超过预算或缺少回执/u)
  assert.equal(fixture.events.some(value => value.event === 'main.rendererProbeComplete' || value.event === 'main.rendererIpcDrained'), false)
})
test('settings status只选settle边界最新周期读取，早paint/错DTO/错sender/错私有身份均不接受', async t => {
  const fixture = await controlledColdWindow(t); await fixture.probe.runWindowProbe(fixture.window)
  const actionId = fixture.events.find(value => value.event === 'main.domAction' && value.data.operation === 'settings-open').data.actionId
  const own = fixture.events.filter(value => value.data.actionId === actionId), renderer = own.filter(value => value.actor === 'renderer'), main = own.filter(value => value.actor === 'main'), snapshot = main.find(value => value.event === 'main.domSettled').data.snapshot
  const evidence = { renderer, main }, original = selectCollectionScaleSettingsStatus(actionId, snapshot, evidence)!
  assert.deepEqual(original, main.find(value => value.event === 'main.domSettled').data.settingsStatusSelection)
  const second = structuredClone(evidence), requestId = randomUUID(), invokeId = 'controlled-second-status'
  second.renderer = second.renderer.concat(second.renderer.map(value => ({ ...value, sequence: value.sequence + 1000, data: { ...value.data, observationId: 'controlled-periodic-latest', generation: 2 } })))
  second.main = second.main.concat(second.main.filter(value => ['main.ipcRequest', 'main.ipcReply', 'main.controlRequest', 'main.controlReply'].includes(value.event)).map(value => {
    const copy = structuredClone(value); copy.data.invokeId = invokeId
    if (copy.data.request) copy.data.request.requestId = requestId
    if (copy.data.response) { copy.data.requestId = requestId; copy.data.response.requestId = requestId }
    return copy
  }))
  const latest = selectCollectionScaleSettingsStatus(actionId, snapshot, second)!
  assert.equal(latest.observationId, 'controlled-periodic-latest'); assert.equal(latest.invokeId, invokeId); assert.equal(latest.requestId, requestId); assert.equal(latest.generation, 2)
  const earlyPaint = structuredClone(second); earlyPaint.renderer = earlyPaint.renderer.filter(value => !(value.event === 'renderer.paint' && value.data.observationId === latest.observationId))
  assert.equal(selectCollectionScaleSettingsStatus(actionId, snapshot, earlyPaint), undefined)
  const staleDom = structuredClone(snapshot); staleDom.readonlySettings = { enabled: false, mode: 'node', state: 'off' }
  assert.equal(selectCollectionScaleSettingsStatus(actionId, staleDom, second), undefined)
  const missingReply = structuredClone(second); missingReply.main = missingReply.main.filter(value => !(value.event === 'main.ipcReply' && value.data.invokeId === invokeId)); assert.equal(selectCollectionScaleSettingsStatus(actionId, snapshot, missingReply), undefined)
  for (const mutate of [
    (value: typeof second) => { value.main.find(event => event.event === 'main.ipcRequest' && event.data.invokeId === invokeId)!.data.sender.rendererPid = 72 },
    (value: typeof second) => { value.main.find(event => event.event === 'main.controlReply' && event.data.requestId === requestId)!.data.response.generationNonce = randomUUID() },
    (value: typeof second) => { value.main.find(event => event.event === 'main.controlReply' && event.data.requestId === requestId)!.data.response.status.errorCode = 'RUST_UNAVAILABLE' },
    (value: typeof second) => { value.renderer.find(event => event.event === 'renderer.commit' && event.data.observationId === latest.observationId)!.data.generation = 1 },
    (value: typeof second) => { value.renderer.push(structuredClone(value.renderer.find(event => event.event === 'renderer.paint' && event.data.observationId === latest.observationId)!)) },
    (value: typeof second) => { value.renderer.push({ ...value.renderer.at(-1)!, event: 'renderer.discarded' }) },
  ]) { const invalid = structuredClone(second); mutate(invalid); assert.throws(() => selectCollectionScaleSettingsStatus(actionId, snapshot, invalid), /status/u) }
})
test('静态型号期待与seed收据身份拒绝串改，生产false拒绝诊断', async t => {
  const value = await profile(t); assert.equal(controlledScaleProfile(process.env).modelCount, 0)
  await writeFile(value.marker.seedReceipt.path, 'changed\n', { mode: 0o600 }); assert.throws(() => controlledScaleProfile(process.env), /收据身份不一致/u)
  Object.defineProperty(globalThis, '__MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__', { configurable: true, value: false }); assert.throws(() => readCollectionScaleProfile(process.env), /静态候选/u)
})
test('原IPC Promise身份/参数与原公开端口不被被动成本观察修改', async t => {
  await profile(t)
  const lines: string[] = [], probe = createCollectionScaleMainProbe({ profileReader: controlledScaleProfile, sink: line => lines.push(line) }), expected = Promise.resolve({ items: [], total: 0, offset: 0, limit: 24 })
  let actualArgs: unknown[] = []
  const listener = probe.observeIpc({ channel: 'collection:list', listener: (_event: unknown, ...args: unknown[]) => { actualArgs = args; return expected }, trustedSender: () => ({ webContentsId: 1, rendererPid: 2, frameUrl: 'musicbridge://app/index.html', trusted: true }) })
  assert.equal(listener({}, { offset: 0, limit: 24 }, {}), expected); await expected; await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(actualArgs, [{ offset: 0, limit: 24 }, {}])
  const events = lines.map(line => JSON.parse(line.slice('RUST015_EVIDENCE '.length))); const entry = events.find(event => event.event === 'main.ipcRequest'), reply = events.find(event => event.event === 'main.ipcReply')
  assert.equal(reply.data.invokeId, entry.data.invokeId); assert.ok(reply.data.durationMs >= 0)
  const port = new EventEmitter() as any; let sent: unknown; port.postMessage = (value: unknown) => { sent = value }; probe.observeControlPort(port)
  const request = { schemaVersion: 1, generationNonce: randomUUID(), requestId: randomUUID(), type: 'status' }; port.postMessage(request); assert.equal(sent, request)
  port.emit('message', { data: { ...request, ok: true, status: { schemaVersion: 1, enabled: false, mode: 'node', state: 'off' } } })
  const control = lines.map(line => JSON.parse(line.slice('RUST015_EVIDENCE '.length))).find(event => event.event === 'main.controlReply'); assert.equal(control.data.requestId, request.requestId); assert.ok(control.data.durationMs >= 0)
})

test('Renderer旧代际不产生paint，原invoke Promise身份保持；伪造/重复动作拒绝', async t => {
  const oldConsole = console.info, oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), oldRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'), oldDefinition = Object.getOwnPropertyDescriptor(globalThis, '__MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__')
  const listeners = new Map<string, (event: any) => void>(), frames: FrameRequestCallback[] = [], events: any[] = []
  Object.defineProperty(globalThis, '__MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__', { configurable: true, value: true })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({}), addEventListener: (name: string, listener: any) => listeners.set(name, listener) } })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length } })
  console.info = (line: string) => events.push(JSON.parse(line.slice('RUST015_EVIDENCE '.length)))
  t.after(() => { console.info = oldConsole; for (const [name, value] of [['document', oldDocument], ['requestAnimationFrame', oldRaf], ['__MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__', oldDefinition]] as const) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name) } })
  const module = await import('../src/renderer/src/collection-scale-observation.js')
  const action = { kind: 'rust015-dom-action', actionId: randomUUID(), operation: 'workload', workload: 'all', iteration: 0, mode: 'node' }
  const listener = listeners.get('musicbridge:collection-scale-action')!; listener({ detail: action }); listener({ detail: action }); listener({ detail: { ...action, actionId: randomUUID(), profile: 'v3-5000' } })
  const old = module.beginCollectionScaleRead('catalog', 1, { page: { offset: 0, limit: 24 }, filter: {} })!
  const work = Promise.resolve({ total: 0 }); assert.equal(module.observeCollectionScaleInvoke(work, old), work); await work
  module.finishCollectionScaleRead(old, false)
  const current = module.beginCollectionScaleRead('catalog', 2, { page: { offset: 0, limit: 24 }, filter: {} })!; module.finishCollectionScaleRead(current, true, { total: 0 }, () => false)
  await new Promise(resolve => setImmediate(resolve)); assert.equal(events.some(event => event.event === 'renderer.paint'), false)
  const accepted = module.beginCollectionScaleRead('catalog', 3, { page: { offset: 0, limit: 24 }, filter: {} })!; module.finishCollectionScaleRead(accepted, true, { total: 0 }); await new Promise(resolve => setImmediate(resolve))
  while (frames.length) frames.shift()!(0)
  const paints = events.filter(event => event.event === 'renderer.paint'); assert.equal(paints.length, 1); assert.equal(paints[0].data.generation, 3); assert.equal(paints[0].data.actionId, action.actionId)
  const { createCollectionReadonlyPreference } = await import('../src/renderer/src/components/settings/collection-readonly-preference.js')
  let finishOld!: (value: any) => void
  const oldOn = new Promise<any>(resolve => { finishOld = resolve }), off = { schemaVersion: 1 as const, enabled: false, mode: 'node' as const, state: 'off' as const }
  const preference = createCollectionReadonlyPreference({ getCollectionReadonlySettings: async () => off, setCollectionReadonlyEnabled: enabled => enabled ? oldOn : Promise.resolve(off) })
  const pending = preference.select(true); await preference.select(false); finishOld({ schemaVersion: 1, enabled: true, mode: 'rust', state: 'ready' }); await pending
  await new Promise(resolve => setImmediate(resolve)); while (frames.length) frames.shift()!(0)
  const controlPaints = events.filter(event => event.event === 'renderer.paint' && event.data.layer === 'control' && event.data.request.operation === 'setEnabled')
  assert.equal(controlPaints.length, 1); assert.equal(controlPaints[0].data.request.enabled, false); assert.equal(controlPaints[0].data.generation, 2); assert.deepEqual(preference.settings.value, off); preference.close()
  assert.equal(events.filter(event => event.event === 'renderer.observationRejected').length, 2)
})

test('Core同clock成本旁路保留原Owner Promise、原public bootstrap与原异常', async t => {
  const value = await profile(t), lines: string[] = [], parent = new EventEmitter(), hooks = installCollectionScaleCoreObserver({ profileReader: controlledScaleProfile, parent, env: { ...process.env, MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_DATA_DIRECTORY: path.join(value.directory, 'data') }, getStatus: () => ({ enabled: false, mode: 'node', state: 'off' }), sink: line => lines.push(line) })
  const source = { prepare: () => Promise.resolve({}), commitBoot: () => Promise.resolve(), dispatch: () => Promise.resolve({ ok: true }), close: () => Promise.resolve(), getCollectionSnapshotVersion: () => Promise.resolve({ datasetId: randomUUID(), epoch: '1', revision: '1' }) } as any
  const expected = source.getCollectionSnapshotVersion(); source.getCollectionSnapshotVersion = () => expected
  const wrapped = hooks.dependencies.decorateDatasetOwner!(source) as any
  assert.equal(wrapped.getCollectionSnapshotVersion(), expected); await expected; await new Promise(resolve => setImmediate(resolve))
  const port = new EventEmitter() as any; let posted: unknown; port.postMessage = (value: unknown) => { posted = value }
  parent.emit('message', { data: { type: 'musicbridge.core.port' }, ports: [port] }); const ready = { event: 'core.ready' }; port.postMessage(ready); assert.equal(posted, ready)
  hooks.onCostObservation({ stage: 'versionProbe', snapshotProfile: 'v2-2000', outcome: 'fulfilled', durationMs: 2 })
  const events = lines.map(line => JSON.parse(line.slice('RUST015_EVIDENCE '.length))); assert.equal(events.some(event => event.event === 'core.publicPortObserved'), true)
  const operation = events.find(event => event.event === 'node.snapshotOperation'); assert.equal(operation.data.operation, 'getCollectionSnapshotVersion'); assert.ok(operation.data.durationMs >= 0); assert.equal(events.find(event => event.event === 'core.cost').data.durationMs, 2)
})
test('Core routerDispatch成本与原public六命令同闭集，辅助业务Promise保留且其它成本阶段照旧', async t => {
  const fixture = await profile(t), lines: string[] = [], parent = new EventEmitter(), hooks = installCollectionScaleCoreObserver({ profileReader: controlledScaleProfile, parent, env: { ...process.env, MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_DATA_DIRECTORY: path.join(fixture.directory, 'data') }, getStatus: () => ({ enabled: false, mode: 'node', state: 'off' }), sink: line => lines.push(line) })
  const allowed = ['commandOutbox.context', 'commandOutbox.execute', 'collection.list', 'collection.detail', 'core.shutdown', 'recordingPrintWorker.claim'], auxiliary = ['referenceCatalog.sources', 'collectionProgress.modelLengths'], received: unknown[] = [], original = Promise.resolve({ synthetic: true })
  const source = { dispatch: (request: unknown) => { received.push(request); return original } } as any, decorated = hooks.dependencies.decorateDatasetOwner!(source)
  for (const operation of auxiliary) {
    const request = { version: 1, id: randomUUID(), command: operation, payload: {} } as any
    assert.equal(decorated.dispatch(request), original); assert.equal(received.at(-1), request)
    hooks.onCostObservation({ stage: 'routerDispatch', operation, requestId: request.id, snapshotProfile: 'v2-2000', outcome: 'fulfilled', durationMs: 1 })
  }
  for (const operation of allowed) hooks.onCostObservation({ stage: 'routerDispatch', operation, requestId: randomUUID(), snapshotProfile: 'v2-2000', outcome: 'fulfilled', durationMs: 2 })
  hooks.onCostObservation({ stage: 'routerDispatch', snapshotProfile: 'v2-2000', outcome: 'rejected', durationMs: 3 })
  for (const stage of ['versionProbe', 'snapshotExport', 'snapshotCopyFreeze', 'frameEncoding', 'nativeRpc', 'tsIndexBuild', 'routerRefresh'] as const) hooks.onCostObservation({ stage, operation: auxiliary[0], snapshotProfile: 'v2-2000', outcome: 'fulfilled', durationMs: 4 })
  await original; await new Promise(resolve => setImmediate(resolve))
  const events = lines.map(line => JSON.parse(line.slice('RUST015_EVIDENCE '.length))), costs = events.filter(event => event.event === 'core.cost')
  assert.deepEqual(costs.filter(event => event.data.stage === 'routerDispatch').map(event => event.data.operation), allowed)
  assert.deepEqual(costs.filter(event => event.data.stage !== 'routerDispatch').map(event => event.data.stage), ['versionProbe', 'snapshotExport', 'snapshotCopyFreeze', 'frameEncoding', 'nativeRpc', 'tsIndexBuild', 'routerRefresh'])
  assert.equal(received.length, 2); assert.equal(events.some(event => event.event === 'node.dispatch' || event.event === 'node.reply'), false)
})

test('真实PassThrough复现Utility exit finally清监听窗口：晚到四帧和UTF8分块仍完整转发', async t => {
  await profile(t)
  const lines: string[] = [], stream = new PassThrough(), child = new EventEmitter() as any
  child.stdout = stream
  const probe = createCollectionScaleMainProbe({ profileReader: controlledScaleProfile, sink: line => lines.push(line) })
  probe.observeChild(child, '/synthetic-core.js', [])
  const tail = ['node.exit', 'node.closeCompleted', 'core.publicReply', 'core.closedStatus'].map((event, index) => 'RUST015_EVIDENCE ' + JSON.stringify({ schemaVersion: 1, actor: 'core', pid: 123, sequence: index + 1, elapsedMs: index, event, data: { text: '樱花🌸' } }) + '\n')
  // 精确模拟官方43.4.0：同步exit回调结束后finally清缓存stdout监听，再交付已写尾帧。
  child.emit('exit', 0); stream.removeAllListeners()
  const raw = Buffer.from(tail.join('')), split = raw.indexOf(Buffer.from('🌸')) + 2
  stream.write(raw.subarray(0, split)); stream.end(raw.subarray(split))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(lines.filter(line => line.includes('"actor":"core"')), tail)
})

test('Core输出排空等真正EOF和Main最后flush，重复调用复用原等待Promise', async t => {
  await profile(t)
  const lines: string[] = [], stream = new PassThrough(), child = new EventEmitter() as any
  let flushCalls = 0, acceptFlush!: () => void, completed = false
  const lastFlush = new Promise<void>(resolve => { acceptFlush = resolve })
  const probe = createCollectionScaleMainProbe({ profileReader: controlledScaleProfile, sink: line => lines.push(line), flush: () => ++flushCalls === 1 ? Promise.resolve() : lastFlush })
  child.stdout = stream; probe.observeChild(child, '/synthetic-core.js', [])
  child.emit('exit', 0); stream.removeAllListeners()
  const waiting = probe.flushCoreEvidence(); assert.equal(probe.flushCoreEvidence(), waiting)
  void waiting.then(() => { completed = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(completed, false); assert.equal(flushCalls, 1)
  stream.end('RUST015_EVIDENCE ' + JSON.stringify({ actor: 'core', event: 'node.exit', data: { code: 0 } }) + '\n')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(flushCalls, 2); assert.equal(completed, false)
  acceptFlush(); await waiting; assert.equal(completed, true)
  assert.equal(stream.listenerCount('data'), 0); assert.equal(stream.listenerCount('end'), 0); assert.equal(stream.listenerCount('close'), 0)
  assert.ok(lines.some(line => line.includes('"actor":"core"') && line.includes('"event":"node.exit"')))
})

test('Core流早已EOF时不重新挂监听或resume，重复EOF恰一次完成', async () => {
  const stream = new PassThrough(); stream.resume()
  const alreadyEnded = new Promise<void>(resolve => stream.once('end', resolve)); stream.end(); await alreadyEnded
  let ends = 0, resumes = 0
  const resume = stream.resume.bind(stream); stream.resume = () => { resumes++; return resume() }
  const drain = createCollectionScaleCoreStreamDrain(stream, { data: () => assert.fail('EOF不应再有数据'), end: () => { ends++ } })
  drain.exit(); drain.exit(); stream.emit('end'); stream.emit('close')
  await waitForCollectionScaleEvidenceDrain([drain], async () => {})
  assert.equal(ends, 1); assert.equal(resumes, 0); assert.equal(stream.listenerCount('data'), 0)
  const live = new PassThrough(), second = createCollectionScaleCoreStreamDrain(live, { data: () => {}, end: () => { ends++ } })
  live.end(); await second.done; live.emit('end'); live.emit('close')
  assert.equal(ends, 2); assert.equal(live.listenerCount('end'), 0)
})

test('Core exit恢复只重挂本probe三监听，保留窗口后其它监听且不重复转发', async () => {
  const stream = new PassThrough(), seen: Buffer[] = []
  let endCount = 0, foreignData = 0, foreignEnd = 0
  const drain = createCollectionScaleCoreStreamDrain(stream, { data: bytes => seen.push(bytes), end: () => { endCount++ } })
  drain.exit(); stream.removeAllListeners()
  const foreign = () => { foreignData++ }, foreignEnded = () => { foreignEnd++ }
  stream.on('data', foreign); stream.on('end', foreignEnded)
  stream.write('真实原尾'); stream.end('帧\n')
  await waitForCollectionScaleEvidenceDrain([drain], async () => {})
  assert.equal(Buffer.concat(seen).toString(), '真实原尾帧\n'); assert.equal(endCount, 1)
  assert.ok(foreignData > 0); assert.equal(foreignEnd, 1)
  assert.deepEqual(stream.listeners('data'), [foreign]); assert.deepEqual(stream.listeners('end'), [foreignEnded])
  drain.exit(); await Promise.resolve(); assert.deepEqual(stream.listeners('data'), [foreign])
  stream.removeListener('data', foreign); stream.removeListener('end', foreignEnded)
})

test('Core流没有EOF时有界拒绝并清理，不将exit冒充排空，也不重新挂已失败监听', async () => {
  const stream = new PassThrough(); let endCount = 0
  const drain = createCollectionScaleCoreStreamDrain(stream, { data: () => {}, end: () => { endCount++ } })
  drain.exit(); stream.removeAllListeners()
  await assert.rejects(waitForCollectionScaleEvidenceDrain([drain], async () => {}, 10), /排空/u)
  drain.exit(); await Promise.resolve()
  assert.equal(endCount, 0); assert.equal(stream.listenerCount('data'), 0); assert.equal(stream.listenerCount('end'), 0); assert.equal(stream.listenerCount('close'), 0)
  await assert.rejects(waitForCollectionScaleEvidenceDrain([], async () => {}, 5001), /预算无效/u)
  stream.destroy()
})

test('Main stdout flush失败原错误拒绝，清理监听且沿原PROBE_FAILED显式失败', async t => {
  await profile(t)
  const lines: string[] = [], error = new Error('受控Main flush失败'), stream = new PassThrough(), child = new EventEmitter() as any
  child.stdout = stream
  const probe = createCollectionScaleMainProbe({ profileReader: controlledScaleProfile, sink: line => lines.push(line), flush: () => Promise.reject(error) })
  probe.observeChild(child, '/synthetic-core.js', [])
  const failure = probe.flushCoreEvidence(); assert.equal(probe.flushCoreEvidence(), failure)
  await assert.rejects(failure, actual => actual === error)
  child.emit('exit', 0); await Promise.resolve()
  assert.equal(stream.listenerCount('data'), 0); assert.equal(stream.listenerCount('end'), 0); assert.equal(stream.listenerCount('close'), 0)
  const failures = lines.map(line => JSON.parse(line.slice('RUST015_EVIDENCE '.length))).filter(event => event.event === 'main.probeFailed')
  assert.equal(failures.length, 1); assert.equal(failures[0].data.code, 'PROBE_FAILED')
  assert.equal(lines.filter(line => line.includes('"event":"node.exit"')).length, 0)
  stream.destroy()
})
