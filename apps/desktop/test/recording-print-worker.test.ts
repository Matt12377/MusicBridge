import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

const tick = () => new Promise(resolve => setImmediate(resolve))
const lease = () => ({ workerId: randomUUID(), leaseId: randomUUID(), jobId: randomUUID(), requestId: randomUUID(), inputHash: 'a'.repeat(64), facts: {}, artworkImage: null, templateId: 'jp0-basic-v1' })
async function subject() {
  const module = await import('../src/main/recording-print-worker.js').catch(() => ({}))
  assert.ok('createRecordingPrintWorker' in module, '缺少与界面无关的持久打印任务worker')
  return (module as typeof import('../src/main/recording-print-worker.js')).createRecordingPrintWorker
}
test('worker无需打开UI自动领取并顺序生成，所有私有调用固定库且不并发', async () => {
  const create = await subject(), datasetId = randomUUID(), first = lease()
  const calls: Array<[string, any, string]> = []
  let renders = 0, closed = 0, release!: (v: any) => void
  const result = { pdfBase64: 'synthetic', pdfSha256: 'b'.repeat(64), preview: {}, pageCount: 2, rendererVersion: 'fixture' }
  const worker = create({ datasetId, intervalMs: 60_000, requestInternal: (async (name: string, payload: any, scope: string) => {
    calls.push([name, payload, scope])
    if (name.endsWith('claim')) return { lease: { ...first, workerId: payload.workerId } }
    return { state: 'ready' }
  }) as never, renderer: { render: (async () => { renders++; return new Promise(resolve => { release = resolve }) }) as never, close: () => { closed++ } } })
  worker.start(); worker.start()
  await tick()
  assert.equal(renders, 1); assert.equal(calls.length, 1)
  release(result); await tick(); await tick()
  assert.equal(calls.length, 2)
  assert.equal(calls[1]![0], 'recordingPrintWorker.complete')
  assert.deepEqual(calls[1]![1], { ...result, workerId: calls[0]![1].workerId, leaseId: first.leaseId, jobId: first.jobId, inputHash: first.inputHash })
  assert.ok(calls.every(call => call[2] === datasetId))
  await worker.stop(); assert.equal(closed, 1)
})
test('排版失败只提交有限错误码，停止后迟到渲染不提交任何结果', async () => {
  const create = await subject(), first = lease(), calls: Array<[string, any]> = []
  let reject!: (e: unknown) => void, closed = 0
  const worker = create({ datasetId: randomUUID(), intervalMs: 60_000, requestInternal: (async (name: string, payload: any) => {
    calls.push([name, payload]); return name.endsWith('claim') ? { lease: { ...first, workerId: payload.workerId } } : { state: 'failed' }
  }) as never, renderer: { render: (async () => { throw Object.assign(new Error('/private/internal'), { code: 'LAYOUT_OVERFLOW' }) }) as never, close: () => { closed++ } } })
  worker.start(); await tick(); await tick()
  assert.equal(calls[1]![0], 'recordingPrintWorker.fail')
  assert.equal(calls[1]![1].errorCode, 'LAYOUT_OVERFLOW')
  assert.ok(!JSON.stringify(calls).includes('/private'))
  await worker.stop()
  const lateCalls: string[] = []
  const late = create({ datasetId: randomUUID(), intervalMs: 60_000, requestInternal: (async (name: string, payload: any) => { lateCalls.push(name); return { lease: { ...first, workerId: payload.workerId } } }) as never,
    renderer: { render: (async () => new Promise((_resolve, fail) => { reject = fail })) as never, close: () => { reject(new Error('停止')); closed++ } } })
  late.start(); await tick(); await late.stop(); await tick()
  assert.deepEqual(lateCalls, ['recordingPrintWorker.claim'])
  assert.equal(closed, 2)
})
test('complete回执未知只重试相同payload一次，不重新渲染或修改冻结输入', async () => {
  const create = await subject(), first = lease(), completions: any[] = []
  let renders = 0
  const worker = create({ datasetId: randomUUID(), intervalMs: 60_000, requestInternal: (async (name: string, payload: any) => {
    if (name.endsWith('claim')) return { lease: { ...first, workerId: payload.workerId } }
    if (name.endsWith('complete')) { completions.push(payload); if (completions.length === 1) throw new Error('回执丢失'); return { state: 'ready' } }
    throw new Error('不应失败已完成任务')
  }) as never, renderer: { render: (async () => { renders++; return { pdfBase64: 'exact-original', pdfSha256: 'b'.repeat(64), preview: {}, pageCount: 2, rendererVersion: 'fixture' } }) as never, close: () => undefined } })
  worker.start(); await tick(); await tick(); await worker.stop()
  assert.equal(renders, 1); assert.equal(completions.length, 2); assert.deepEqual(completions[0], completions[1])
})

test('Main在Core就绪时启动打印worker，失效与退出时停止，公开preload接八入口', async () => {
  const { readFile } = await import('node:fs/promises')
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const preload = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  assert.match(main, /installRecordingPrintHandlers\(/u)
  assert.match(main, /onReady: async client => \{\s*lifecycleProbe\.mark\('core-ready-received'\)\s*await startRecordingPrintWorker\(client\)/u)
  assert.match(main, /onLifecycle: \(event\) => \{\s*if \(event.event === 'spawn'\) lifecycleProbe\.mark\('core-spawn'\)[\s\S]*?if \(event.event !== 'ready'\) stopRecordingPrintWorker\(\)/u)
  assert.match(main, /quitAfterCoreShutdown = true\s*stopRecordingPrintWorker\(\)/u)
  assert.match(preload, /createRecordingPrintClient\(\(channel, value\) => ipcRenderer.invoke\(channel, value\)\)/u)
})
