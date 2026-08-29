import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import type { RecordingPrintLease } from '@music-bridge/contracts'
import type { RecordingPrintWindow } from '../src/main/recording-print-renderer.js'

const load = () => import('../src/main/recording-print-renderer.js')
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function lease(): RecordingPrintLease {
  return { leaseId: randomUUID(), workerId: randomUUID(), jobId: randomUUID(), requestId: randomUUID(), inputHash: 'a'.repeat(64), templateId: 'jp0-basic-v1', artworkImage: null,
    facts: { schemaVersion: 1, recordingId: randomUUID(), recordingContentHash: 'b'.repeat(64), planVersionId: randomUUID(), planContentHash: 'c'.repeat(64), physicalId: 'MB-C-00427', title: '合成中文录音标题', spine: '合成中文录音标题', completedAt: '2026-08-29T01:02:03.000Z', displayDateUtc: '2026-08-29', tapeModel: { state: 'unknown' }, artwork: { state: 'not-captured', reason: 'not-provided' },
      sides: [{ side: 'A', frameCount: 48000, sampleRate: 48000, durationMs: 1000, tracks: [{ position: 1, trackId: randomUUID(), title: '第一首合成曲目', artist: '合成艺术家' }] }, { side: 'B', frameCount: 0, sampleRate: 48000, durationMs: 0, tracks: [] }] } }
}
/** 最小经典xref结构，只做页盒/字节边界测试，不冒真实排版PDF。 */
function pdfFixture(options: { width?: string; height?: string; origin?: string; extra?: string; count?: number; parent?: number; xref?: boolean } = {}): Buffer {
  const objects = ['<</Type /Catalog\n/Pages 2 0 R>>', `<</Type /Pages\n/Count ${options.count ?? 3}\n/Kids [3 0 R 4 0 R 5 0 R]>>`,
    ...[3, 4, 5].map(() => `<</Type /Page\n/Resources <<>>\n/MediaBox [${options.origin ?? '0'} 0 ${options.width ?? '293.04001'} ${options.height ?? '288'}]\n/Contents 6 0 R\n/Parent ${options.parent ?? 2} 0 R${options.extra ?? ''}>>`),
    '<</Length 36>> stream\n/MediaBox [0 0 293.04001 288] 合成流\nendstream']
  let source = '%PDF-1.7\n', offsets = [0]
  for (const [index, body] of objects.entries()) { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${body}\nendobj\n` }
  const start = Buffer.byteLength(source)
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  source += `trailer\n<</Size ${objects.length + 1}\n/Root 1 0 R>>\nstartxref\n${options.xref === false ? start - 1 : start}\n%%EOF\n`
  return Buffer.from(source)
}
function harness(options: { load?: Promise<void>; loadError?: boolean; printError?: boolean; layout?: unknown; pdf?: Buffer; previewBytes?: number; throwAfterDestroy?: boolean; cleanupError?: boolean } = {}) {
  const ses = new EventEmitter() as EventEmitter & RecordingPrintWindow['webContents']['session'] & Record<string, any>
  ses.webRequest = { onBeforeRequest(listener: unknown) { if (listener === null && options.cleanupError) throw new Error('/private/synthetic-cleanup-error'); ses.beforeRequest = listener } }
  ses.setPermissionCheckHandler = (handler: unknown) => { ses.permissionCheck = handler }
  ses.setPermissionRequestHandler = (handler: unknown) => { ses.permissionRequest = handler }
  const contents = new EventEmitter() as EventEmitter & RecordingPrintWindow['webContents'] & Record<string, any>
  contents.session = ses
  const calls: string[] = []; let capturedOptions: any, html = '', printOptions: any, destroyCount = 0
  contents.setWindowOpenHandler = (handler: unknown) => { contents.windowOpen = handler }
  contents.setAudioMuted = (muted: boolean) => { assert.equal(muted, true) }
  contents.executeJavaScript = async (_script: string) => { calls.push('layout'); return options.layout ?? { ok: true, pageCount: 3 } }
  contents.printToPDF = async (value: unknown) => { printOptions = value; calls.push('pdf'); if (options.printError) throw new Error('/private/synthetic-print-error'); return options.pdf ?? pdfFixture() }
  contents.capturePage = async (rect: unknown, captureOptions: unknown) => { calls.push('capture'); assert.ok(rect); assert.deepEqual(captureOptions, { stayHidden: true, stayAwake: true }); return { isEmpty: () => false, getSize: () => ({ width: 390, height: 384 }), toJPEG: () => options.previewBytes ? Buffer.alloc(options.previewBytes) : Buffer.from('/9j/2Q==', 'base64') } }
  const win = { webContents: contents, isDestroyed: () => destroyCount > 0, destroy() { ++destroyCount; contents.emit('destroyed') }, async loadURL(url: string) { calls.push('load'); html = decodeURIComponent(url.slice(url.indexOf(',') + 1)); if (options.loadError) throw new Error('/private/synthetic-load-error'); await options.load } }
  if (options.throwAfterDestroy) Object.defineProperty(win, 'webContents', { get() { if (destroyCount) throw new Error('合成已销毁窗口'); return contents } })
  return { createWindow(value: unknown) { capturedOptions = value; return win }, win, contents, ses, calls, values: () => ({ capturedOptions, html, printOptions, destroyCount }) }
}

test('渲染器只创建独立受限隐藏窗口，PDF选项固定真实尺寸，成功关闭一次', async () => {
  const module = await load(), h = harness(), renderer = module.createRecordingPrintRenderer({ createWindow: h.createWindow })
  const result = await renderer.render(lease()), { capturedOptions: o, printOptions: p, destroyCount } = h.values()
  assert.equal(o.show, false); assert.equal(o.webPreferences.sandbox, true); assert.equal(o.webPreferences.contextIsolation, true); assert.equal(o.webPreferences.nodeIntegration, false); assert.equal(o.webPreferences.webSecurity, true)
  assert.equal(o.webPreferences.preload, undefined); assert.equal(o.webPreferences.partition.startsWith('persist:'), false)
  assert.deepEqual(p.pageSize, { width: 4.0625, height: 4 }); assert.equal(p.preferCSSPageSize, true); assert.equal(p.scale, 1); assert.deepEqual(p.margins, { top: 0, bottom: 0, left: 0, right: 0 })
  assert.equal(p.printBackground, true); assert.equal(p.displayHeaderFooter, false); assert.equal(destroyCount, 1); assert.equal(result.pageCount, 3)
  assert.ok(Buffer.from(result.pdfBase64, 'base64').includes(Buffer.from('/MediaBox [0 0 292.5 ')), '发布真实页盒必须为精确JP0宽度')
  assert.equal(result.pdfSha256, createHash('sha256').update(Buffer.from(result.pdfBase64, 'base64')).digest('hex')); assert.equal(result.preview.width, 390)
  assert.equal(h.ses.beforeRequest, null); assert.equal(h.ses.permissionCheck, null); assert.equal(h.ses.permissionRequest, null)
  assert.equal(result.rendererVersion, `jp0-v1-box1-preview2-electron-${process.versions.electron ?? 'none'}-chrome-${process.versions.chrome ?? 'none'}`)
  assert.ok(result.rendererVersion.length <= 120 && !result.rendererVersion.includes('/')); renderer.close(); assert.equal(h.values().destroyCount, 1)
})

test('网络、导航、新窗口、下载与权限全部拒绝，只有本次固定data文档可加载', async () => {
  const module = await load(), gate = deferred<void>(), h = harness({ load: gate.promise }), renderer = module.createRecordingPrintRenderer({ createWindow: h.createWindow })
  const pending = renderer.render(lease()); await tick()
  for (const url of ['https://example.invalid/image.jpg', 'file:///private/synthetic.png', 'http://127.0.0.1/test']) {
    let response: unknown; h.ses.beforeRequest({ url }, (value: unknown) => { response = value }); assert.deepEqual(response, { cancel: true })
  }
  for (const eventName of ['will-navigate', 'will-redirect', 'will-attach-webview']) { let prevented = false; h.contents.emit(eventName, { preventDefault() { prevented = true } }, 'https://example.invalid'); assert.equal(prevented, true) }
  let prevented = false; h.ses.emit('will-download', { preventDefault() { prevented = true } }); assert.equal(prevented, true)
  assert.deepEqual(h.contents.windowOpen({ url: 'https://example.invalid' }), { action: 'deny' }); assert.equal(h.ses.permissionCheck(), false)
  let allowed: unknown; h.ses.permissionRequest(undefined, 'media', (value: unknown) => { allowed = value }); assert.equal(allowed, false)
  gate.resolve(); await pending; renderer.close()
})

test('用户文字逐项escape且缺Artwork诚实，模板没有网络、用户脚本或裁切省略', async () => {
  const module = await load(), h = harness(), renderer = module.createRecordingPrintRenderer({ createWindow: h.createWindow }), input = lease()
  input.facts.title = '标题 <script>alert(1)</script> & "'; input.facts.spine = input.facts.title; input.facts.sides[0]!.tracks[0]!.title = '<img src="https://example.invalid">'
  await renderer.render(input); const html = h.values().html
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert.ok(html.includes('&lt;img')); assert.equal(html.includes('<script>'), false)
  assert.ok(html.includes('历史 Artwork 未提供')); assert.ok(html.includes('历史型号未知')); assert.ok(html.includes('B 面未使用')); assert.ok(html.includes('7.5pt'))
  assert.equal(/text-overflow:\s*ellipsis|line-clamp/u.test(html), false); renderer.close()
})

for (const stage of ['load', 'print'] as const) test(`${stage}失败保持有限错误且关闭隐藏窗口，不返回假Artifact`, async () => {
  const module = await load(), h = harness({ loadError: stage === 'load', printError: stage === 'print' }), renderer = module.createRecordingPrintRenderer({ createWindow: h.createWindow })
  await assert.rejects(renderer.render(lease()), (error: any) => error.code === 'RENDER_FAILED' && !error.message.includes('/private'))
  assert.equal(h.values().destroyCount, 1); renderer.close()
})

test('超时销毁窗口，迟到load不再print，close后不得复活', async () => {
  const module = await load(), gate = deferred<void>(), h = harness({ load: gate.promise, throwAfterDestroy: true }), renderer = module.createRecordingPrintRenderer({ createWindow: h.createWindow, timeoutMs: 5 })
  await assert.rejects(renderer.render(lease()), { code: 'RENDER_TIMEOUT' }); assert.equal(h.values().destroyCount, 1)
  gate.resolve(); await tick(); assert.deepEqual(h.calls, ['load']); renderer.close(); await assert.rejects(renderer.render(lease()), { code: 'RENDER_FAILED' })
})

for (const stage of ['timeout', 'close'] as const) for (const broken of ['isDestroyed', 'destroy'] as const) test(`${stage}期间${broken}异常不逸出且保留首个有限终因`, async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const module = await load(), gate = deferred<void>(), h = harness({ load: gate.promise }), next = harness()
  let created = 0
  const renderer = module.createRecordingPrintRenderer({ createWindow: options => (++created === 1 ? h : next).createWindow(options), timeoutMs: 5 })
  const pending = renderer.render(lease()).then(() => ({ code: 'unexpected-success' }), (error: { code: string }) => error)
  await tick()
  h.win[broken] = () => { throw new Error('/private/synthetic-destroy-error') }
  let escaped: unknown
  try { if (stage === 'timeout') context.mock.timers.tick(5); else renderer.close() } catch (error) { escaped = error }
  const outcome = await pending
  gate.resolve(); await tick()
  assert.equal(escaped, undefined, '销毁异常不能从定时器或close逸出')
  assert.equal(outcome.code, stage === 'timeout' ? 'RENDER_TIMEOUT' : 'RENDER_FAILED')
  assert.deepEqual(h.calls, ['load'], '迟到load不得继续排版或打印')
  if (stage === 'timeout') await renderer.render(lease())
  else await assert.rejects(renderer.render(lease()), { code: 'RENDER_FAILED' })
  renderer.close()
})

test('close先于异步工厂返回仍销毁迟到窗口，不能加载或发布', async () => {
  const module = await load(), gate = deferred<ReturnType<typeof harness>['win']>(), h = harness(), renderer = module.createRecordingPrintRenderer({ createWindow: () => gate.promise })
  const pending = renderer.render(lease()); await tick(); renderer.close(); await assert.rejects(pending, { code: 'RENDER_FAILED' })
  gate.resolve(h.win); await tick(); assert.equal(h.values().destroyCount, 1); assert.deepEqual(h.calls, [])
})

test('会话监听清理异常仍销毁窗口并释放忙状态，不暴露内部错误或发布结果', async () => {
  const module = await load(), h = harness({ cleanupError: true }), next = harness(); let created = 0
  const renderer = module.createRecordingPrintRenderer({ createWindow: options => (++created === 1 ? h : next).createWindow(options) })
  await assert.rejects(renderer.render(lease()), (error: any) => error.code === 'RENDER_FAILED' && !error.message.includes('/private'))
  assert.equal(h.values().destroyCount, 1)
  await renderer.render(lease()); assert.equal(next.values().destroyCount, 1); renderer.close()
})

test('同实例禁止并发，输入复制后等待不受调用方修改；一任务完成后可处理下一份', async () => {
  const module = await load(), gate = deferred<void>(), h = harness({ load: gate.promise }), next = harness(); let created = 0
  const renderer = module.createRecordingPrintRenderer({ createWindow: options => (++created === 1 ? h : next).createWindow(options) })
  const input = lease(), pending = renderer.render(input); input.facts.title = '迟到篡改'; await tick()
  await assert.rejects(renderer.render(lease()), { code: 'RENDER_FAILED' }); assert.equal(h.values().html.includes('迟到篡改'), false)
  gate.resolve(); await pending; await renderer.render(lease()); assert.equal(created, 2); assert.equal(next.values().destroyCount, 1); renderer.close()
})

for (const layout of [{ ok: false, errorCode: 'LAYOUT_OVERFLOW' }, { ok: true, pageCount: 25 }, { ok: true, pageCount: 0 }, { ok: true, pageCount: 3, extra: true }]) test(`布局结果拒绝无效/超页数 ${JSON.stringify(layout)}`, async () => {
  const module = await load(), h = harness({ layout }), renderer = module.createRecordingPrintRenderer({ createWindow: h.createWindow })
  await assert.rejects(renderer.render(lease()), (error: any) => ['LAYOUT_OVERFLOW', 'RENDER_FAILED'].includes(error.code)); assert.equal(h.calls.includes('pdf'), false); assert.equal(h.values().destroyCount, 1); renderer.close()
})

for (const options of [{ pdf: Buffer.alloc(4 * 1024 * 1024 + 1) }, { pdf: Buffer.from('不是PDF') }, { previewBytes: 1024 * 1024 + 1 }]) test('对象预算或PDF签名无效时拒绝，不把测试字节冒充独立PDF验证', async () => {
  const module = await load(), h = harness(options), renderer = module.createRecordingPrintRenderer({ createWindow: h.createWindow })
  await assert.rejects(renderer.render(lease()), (error: any) => ['OBJECT_LIMIT', 'RENDER_FAILED'].includes(error.code)); assert.equal(h.values().destroyCount, 1); renderer.close()
})

test('页盒只沿经典xref对象定位修改，精确292.5pt，原对象/流/xref偏移不变', async () => {
  const { normalizeRecordingPrintPdf } = await import('../src/main/recording-print-pdf.js')
  const input = pdfFixture(), original = Buffer.from(input), result = normalizeRecordingPrintPdf(input, 3)
  assert.deepEqual(input, original); assert.equal(result.length, input.length)
  assert.equal(result.toString().split('/MediaBox [0 0 292.5     288]').length - 1, 3)
  assert.ok(result.includes(Buffer.from('/MediaBox [0 0 293.04001 288] 合成流')))
  const xref = input.indexOf(Buffer.from('xref\n')); assert.deepEqual(result.subarray(xref), input.subarray(xref))
  const expected = Buffer.from(input.toString().replaceAll('/MediaBox [0 0 293.04001 288]\n/Contents', '/MediaBox [0 0 292.5     288]\n/Contents'))
  assert.deepEqual(result, expected); assert.deepEqual(normalizeRecordingPrintPdf(result, 3), result)
})

for (const [name, options, expectedPages] of [
  ['xref偏移损坏', { xref: false }, 3], ['重复页盒', { extra: '\n/MediaBox [0 0 293.04001 288]' }, 3],
  ['CropBox', { extra: '\n/CropBox [0 0 293 288]' }, 3], ['TrimBox', { extra: '\n/TrimBox [0 0 293 288]' }, 3],
  ['BleedBox', { extra: '\n/BleedBox [0 0 293 288]' }, 3], ['ArtBox', { extra: '\n/ArtBox [0 0 293 288]' }, 3], ['旋转', { extra: '\n/Rotate 90' }, 3],
  ['向内裁切', { width: '292.4' }, 3], ['未知向外尺寸', { width: '294.04' }, 3], ['非零原点', { origin: '1' }, 3],
  ['未知高度', { height: '289' }, 3], ['layout页数不一致', {}, 2], ['页树Count不一致', { count: 2 }, 3], ['页树Parent不一致', { parent: 1 }, 3],
] as const) test(`页盒规范化拒绝${name}，不发布近似尺寸`, async () => {
  const { normalizeRecordingPrintPdf } = await import('../src/main/recording-print-pdf.js')
  assert.throws(() => normalizeRecordingPrintPdf(pdfFixture(options), expectedPages))
})

test('页盒拒绝xref stream/压缩对象入口，不退回全文搜索', async () => {
  const { normalizeRecordingPrintPdf } = await import('../src/main/recording-print-pdf.js')
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<</Type /XRef /Size 2 /Length 0>>\nstream\n\nendstream\nendobj\nstartxref\n9\n%%EOF\n')
  assert.throws(() => normalizeRecordingPrintPdf(pdf, 1))
})
