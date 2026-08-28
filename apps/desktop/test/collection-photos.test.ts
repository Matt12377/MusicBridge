import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import type { CollectionPhotoImage } from '@music-bridge/contracts'
import { pickCollectionPhoto, type PhotoDecoderImage } from '../src/main/collection-photos.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZAAAAABJRU5ErkJggg==', 'base64')
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
function decoder(width = 1, height = 1): PhotoDecoderImage {
  return { isEmpty: () => false, getSize: () => ({ width, height }), resize: size => decoder(size.width, size.height), toJPEG: () => jpeg }
}
test('照片选择取消不读取文件，不调用解码器', async () => {
  assert.equal(await pickCollectionPhoto(async () => ({ canceled: true, filePaths: [] }), () => { throw new Error('不应调用') }), null)
})
test('照片导入只读取选择文件，生成有界副本且原文件字节不变', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-photos-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'sample.png'); await writeFile(filePath, png)
  const result = await pickCollectionPhoto(async () => ({ canceled: false, filePaths: [filePath] }), bytes => { assert.deepEqual(bytes, png); return decoder() })
  assert.deepEqual(result, { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 })
  assert.deepEqual(await readFile(filePath), png)
})
test('拒绝符号链接、伪装格式、像素炸弹和缺失路径；错误不泄露文件位置', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-photos-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const good = path.join(directory, 'source.png'); await writeFile(good, png)
  const link = path.join(directory, 'link.png'); await symlink(good, link)
  const fake = path.join(directory, 'fake.jpg'); await writeFile(fake, png)
  const bomb = path.join(directory, 'bomb.png'); const large = Buffer.from(png); large.writeUInt32BE(50000, 16); await writeFile(bomb, large)
  for (const file of [link, fake, bomb, path.join(directory, 'missing.png'), directory]) {
    await assert.rejects(pickCollectionPhoto(async () => ({ canceled: false, filePaths: [file] }), () => { throw new Error('非法文件不应解码') }), (e: Error) => !e.message.includes(directory) && !e.message.includes('不应解码'))
  }
})
test('解码失败和展示副本超限明确失败，不返回部分照片', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-photos-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'sample.png'); await writeFile(filePath, png)
  const select = async () => ({ canceled: false, filePaths: [filePath] })
  await assert.rejects(pickCollectionPhoto(select, () => ({ ...decoder(), isEmpty: () => true })), /无法解码/u)
  await assert.rejects(pickCollectionPhoto(select, () => { throw new Error(filePath) }), e => e instanceof Error && !e.message.includes(filePath))
  await assert.rejects(pickCollectionPhoto(select, () => ({ ...decoder(), toJPEG: () => Buffer.alloc(2_000_000) })), /过大/u)
})

interface PhotoHost {
  tag: string; text: string; children: PhotoHost[]; parent: PhotoHost | null; props: Record<string, unknown>; open: boolean
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number }
  showModal(): void; close(): void
  addEventListener(): void; removeEventListener(): void; readonly options: PhotoHost[]
}
const photo = { id: '11111111-1111-4111-8111-111111111111', width: 80, height: 160, source: 'user-photo' }
const image: CollectionPhotoImage = { dataUrl: 'data:image/png;base64,' + png.toString('base64'), width: 80, height: 160 }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function mountedPhoto(t: test.TestContext, options: {
  name?: 'CollectionPhoto' | 'CollectionPhotos' | 'PhysicalMusicView'; props?: Record<string, unknown>; api?: Record<string, unknown>
  observer?: 'missing' | 'throws'; outerButton?: boolean
} = {}) {
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const { parse, compileScript } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const observers: { target?: PhotoHost; disconnected: boolean; options?: IntersectionObserverInit; fire(visible: boolean): void }[] = []
  const listeners = new Map<string, Set<() => void>>(), frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0, top = 5_000
  const window = {
    innerHeight: 800, innerWidth: 720, musicBridge: options.api ?? {},
    addEventListener(name: string, callback: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(callback) },
    removeEventListener(name: string, callback: () => void) { listeners.get(name)?.delete(callback) },
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame(id: number) { frames.delete(id) },
    IntersectionObserver: options.observer === 'missing' ? undefined : class {
      target?: PhotoHost; disconnected = false
      options?: IntersectionObserverInit
      constructor(private callback: (entries: unknown[]) => void, observerOptions?: IntersectionObserverInit) { if (options.observer === 'throws') throw new Error('合成Observer不可用'); this.options = observerOptions; observers.push(this) }
      observe(target: PhotoHost) { this.target = target }
      disconnect() { this.disconnected = true }
      fire(visible: boolean) { this.callback([{ target: this.target, isIntersecting: visible }]) }
    }
  }
  const display = await import('../src/renderer/src/components/collection/collection-display.js')
  async function component(name: string): Promise<import('vue').Component> {
    const filename = name + '.vue', { descriptor, errors } = parse(await readFile(new URL(`../src/renderer/src/components/collection/${filename}`, import.meta.url), 'utf8'), { filename }); assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: 'photo-behavior-' + name, inlineTemplate: true })
    const child = name !== 'CollectionPhoto' ? await component('CollectionPhoto') : undefined
    const load = (id: string) => id === 'vue' ? vue : id === './CollectionPhoto.vue' ? { default: child } : id.includes('collection-display') ? display : id.endsWith('.vue') ? { default: { render: () => null } } : require(id)
    const module = { exports: {} as { default: import('vue').Component } }
    new Function('require', 'module', 'exports', 'window', ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(load, module, module.exports, window)
    return module.exports.default
  }
  function node(tag = ''): PhotoHost {
    return { tag, text: '', children: [], parent: null, props: {}, open: false,
      getBoundingClientRect: () => ({ top, bottom: top + 160, left: 0, right: 80, width: 80, height: 160 }),
      showModal() { this.open = true }, close() { this.open = false; (this.props.onClose as (() => void) | undefined)?.() },
      addEventListener() {}, removeEventListener() {}, get options() { return this.children.filter(child => child.tag === 'option') } }
  }
  const renderer = vue.createRenderer<PhotoHost, PhotoHost>({
    createElement: node, createText(text) { const result = node('#text'); result.text = text; return result }, createComment: () => node('#comment'),
    setText(node, text) { node.text = text }, setElementText(node, text) { node.text = text; node.children = [] },
    patchProp(node, name, _previous, value) { node.props[name] = value },
    insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) },
    remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: node => node.parent,
    nextSibling(node) { return node.parent?.children[(node.parent?.children.indexOf(node) ?? -1) + 1] ?? null }
  })
  const Component = await component(options.name ?? 'CollectionPhoto'), props = vue.reactive<Record<string, unknown>>({ photo, alt: '合成竖图', ...options.props })
  const root = node('root'), app = renderer.createApp({ render: () => options.outerButton ? vue.h('button', [vue.h(Component, props)]) : vue.h(Component, props) })
  app.mount(root); let closed = false
  function unmount() { if (!closed) { closed = true; app.unmount() } }
  t.after(unmount)
  const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick() }
  const all = (current = root): PhotoHost[] => [current, ...current.children.flatMap(child => all(child))]
  const text = (current = root): string => current.text + current.children.map(child => text(child)).join(' ')
  async function click(label: string) { const button = all().find(node => node.tag === 'button' && (text(node) === label || node.props['aria-label'] === label)); assert.ok(button, `缺少可操作按钮：${label}`); void (button.props.onClick as () => unknown)(); await tick() }
  await tick()
  return { props, observers, listeners, frames, root, all, text, click, tick, unmount, near: () => { top = 20 }, scroll: () => { for (const callback of listeners.get('scroll') ?? []) callback() }, flushFrame: async () => { const pending = [...frames.values()]; frames.clear(); for (const frame of pending) frame(0); await tick() } }
}

test('照片实际SFC离屏不读字节，近可视才singleflight且保留尺寸与替代文字', async t => {
  const pending = deferred<CollectionPhotoImage>(); let calls = 0
  const view = await mountedPhoto(t, { props: { loadPhoto: async () => { calls++; return pending.promise } }, outerButton: true })
  assert.equal(calls, 0, '挂载离屏照片不得立即调用API'); assert.match(view.text(), /尚未读取/u)
  assert.equal(view.all().find(node => node.props['data-photo-id'] === photo.id)?.props['data-photo-state'], 'idle')
  assert.equal(view.observers.length, 1); assert.equal(view.observers[0]?.options?.rootMargin, '200px')
  view.observers[0]!.fire(false); await view.tick(); assert.equal(calls, 0)
  view.observers[0]!.fire(true); view.observers[0]!.fire(true); await view.tick(); assert.equal(calls, 1); assert.match(view.text(), /正在读取照片/u)
  assert.equal(view.all().find(node => node.props['data-photo-id'] === photo.id)?.props['data-photo-state'], 'loading')
  pending.resolve(image); await view.tick()
  const rendered = view.all().find(node => node.tag === 'img')!
  assert.equal(rendered.props.src, image.dataUrl); assert.equal(rendered.props.width, 80); assert.equal(rendered.props.height, 160); assert.equal(rendered.props.alt, '合成竖图')
  assert.equal(view.all().find(node => node.props['data-photo-id'] === photo.id)?.props['data-photo-state'], 'ready')
  assert.equal(view.all().filter(node => node.tag === 'button').length, 1, '卡片内照片默认不产生嵌套button')
})

test('照片id与loader变化使旧交叉回调及迟到结果失效，同id换loader重新按需读', async t => {
  const old = deferred<CollectionPhotoImage>(), current = deferred<CollectionPhotoImage>(); const calls: string[] = []
  const view = await mountedPhoto(t, { props: { loadPhoto: async (id: string) => { calls.push(id); return id === photo.id ? old.promise : current.promise } } })
  assert.equal(calls.length, 0); view.observers[0]!.fire(true); await view.tick()
  const secondId = '22222222-2222-4222-8222-222222222222'; view.props.photo = { ...photo, id: secondId }; await view.tick()
  view.observers[0]!.fire(true); await view.tick(); assert.deepEqual(calls, [photo.id])
  view.observers[1]!.fire(true); await view.tick(); assert.deepEqual(calls, [photo.id, secondId])
  current.resolve({ ...image, dataUrl: 'data:image/png;base64,current' }); await view.tick(); old.reject(new Error('旧加载迟到失败')); await view.tick()
  assert.equal(view.all().find(node => node.tag === 'img')?.props.src, 'data:image/png;base64,current')
  let changed = 0; view.props.loadPhoto = async () => { changed++; return image }; await view.tick()
  assert.equal(changed, 0); assert.equal(view.all().some(node => node.tag === 'img'), false)
  view.observers[2]!.fire(true); await view.tick(); assert.equal(changed, 1); assert.equal(view.all().find(node => node.tag === 'img')?.props.src, image.dataUrl)
})

test('照片卸载清观察并忽略迟到成功，旧observer不能发起新请求', async t => {
  const pending = deferred<CollectionPhotoImage>(); let calls = 0
  const view = await mountedPhoto(t, { props: { loadPhoto: async () => { calls++; return pending.promise } } })
  assert.equal(calls, 0); view.observers[0]!.fire(true); await view.tick(); view.unmount()
  assert.equal(view.observers[0]!.disconnected, true); view.observers[0]!.fire(true); pending.resolve(image); await view.tick()
  assert.equal(calls, 1); assert.equal(view.root.children.length, 0)
})

for (const observer of ['missing', 'throws'] as const) test(`照片Observer${observer}降级仍不读离屏，滚动单帧检查且命中后清监听`, async t => {
  let calls = 0
  const view = await mountedPhoto(t, { observer, props: { loadPhoto: async () => { calls++; return image } } })
  assert.equal(calls, 0); view.scroll(); view.scroll(); view.scroll(); assert.equal(view.frames.size, 1)
  await view.flushFrame(); assert.equal(calls, 0)
  view.near(); view.scroll(); view.scroll(); await view.flushFrame(); assert.equal(calls, 1)
  assert.equal(view.listeners.get('scroll')?.size ?? 0, 0); assert.equal(view.listeners.get('resize')?.size ?? 0, 0); assert.equal(view.frames.size, 0)
})

test('照片降级滚动检查尚在排队时卸载，取消该帧和全部监听且不读取', async t => {
  let calls = 0
  const view = await mountedPhoto(t, { observer: 'missing', props: { loadPhoto: async () => { calls++; return image } } })
  view.near(); view.scroll(); assert.equal(view.frames.size, 1)
  view.unmount(); assert.equal(view.frames.size, 0)
  assert.equal(view.listeners.get('scroll')?.size ?? 0, 0); assert.equal(view.listeners.get('resize')?.size ?? 0, 0)
  await view.flushFrame(); assert.equal(calls, 0)
})

test('大图读取失败与img解码失败均明确失败，只能显式单图重试且读取中不重复', async t => {
  let calls = 0; const retry = deferred<CollectionPhotoImage>()
  const view = await mountedPhoto(t, { props: { interactive: true, loadPhoto: async () => { if (++calls === 1) throw new Error('/private/photo.png'); return retry.promise } } })
  assert.equal(calls, 0); view.observers[0]!.fire(true); await view.tick()
  assert.match(view.text(), /照片读取失败/u); assert.doesNotMatch(view.text(), /private/u)
  assert.equal(view.all().find(node => node.props['data-photo-id'] === photo.id)?.props['data-photo-state'], 'failed')
  view.observers[0]!.fire(true); await view.tick(); assert.equal(calls, 1, '失败后不因observer重复通知自动重试')
  const retryClick = view.all().find(node => node.tag === 'button')!.props.onClick as () => unknown
  await view.click('重试此照片'); void retryClick(); await view.tick(); assert.equal(calls, 2); assert.match(view.text(), /正在读取照片/u)
  retry.resolve(image); await view.tick(); const img = view.all().find(node => node.tag === 'img')!
  await (img.props.onError as () => void)(); await view.tick(); assert.match(view.text(), /照片读取失败/u)
  await view.click('重试此照片'); assert.equal(calls, 3); assert.equal(view.all().find(node => node.tag === 'img')?.props.src, image.dataUrl)
  await (img.props.onError as () => void)(); await view.tick()
  assert.equal(view.all().find(node => node.tag === 'img')?.props.src, image.dataUrl, '上一张图片迟到的解码错误不能覆盖重试成功结果')
})

for (const name of ['CollectionPhotos', 'PhysicalMusicView'] as const) test(`${name}真实大图提供局部重试，卡片按钮无嵌套且不重读其他图`, async t => {
  let calls = 0
  const loader = async () => { if (++calls === 1) throw new Error('合成单图失败'); return image }
  const detail = { model: { id: photo.id, brand: '合成品牌', name: '合成型号', revision: 1 }, photos: [photo] }
  const music = { entry: { id: photo.id, title: '合成发行版', artist: '合成作者', kind: 'cd', quantity: 1 }, release: { completeness: 'basic', tracks: [] }, photos: [photo] }
  const view = await mountedPhoto(t, { name, props: name === 'CollectionPhotos' ? { detail, busy: false } : { requestedId: photo.id, active: true }, api: { getCollectionPhoto: loader, getPhysicalMusicPhoto: loader, getPhysicalMusic: async () => music } })
  await view.click(name === 'CollectionPhotos' ? '查看实物照片 1' : '查看发行版照片 1')
  assert.equal(calls, 0); assert.equal(view.observers.length, 2)
  view.observers[1]!.fire(true); await view.tick(); await view.click('重试此照片'); assert.equal(calls, 2)
  for (const button of view.all().filter(node => node.tag === 'button')) assert.equal(view.all(button).slice(1).some(node => node.tag === 'button'), false)
  assert.equal(view.observers[0]!.disconnected, false, '局部重试不触发未可视缩略图')
})
