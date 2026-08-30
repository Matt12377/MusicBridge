import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { CollectionPhotoImage } from '@music-bridge/contracts'

type PhotoChannel = 'collection:photo' | 'physicalMusic:photo'
interface PhotoProbe {
  calls: { channel: PhotoChannel; id: string }[]
  failures: { channel: PhotoChannel; id: string }[]
  armed?: { channel: PhotoChannel; id: string }
  restore(): void
}
interface PhotoWorkflowContext { app: ElectronApplication; page: Page; directory: string; outputPath(name: string): string }

/** 仅操作本次临时合成资料；正常读取、导入、库存与照片持久化均经过正式入口。 */
export async function verifyTask071Photos({ app, page, directory, outputPath }: PhotoWorkflowContext): Promise<void> {
  const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
  await app.evaluate(({ ipcMain, dialog }) => {
    const host = globalThis as typeof globalThis & { task071PhotoProbe?: PhotoProbe }
    if (host.task071PhotoProbe) throw new Error('照片探针不得重复安装')
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
    const channels = ['collection:photo', 'physicalMusic:photo'] as const
    const originals = channels.map(channel => { const handler = handlers.get(channel); if (!handler) throw new Error('缺少正式照片读取入口'); return { channel, handler } })
    const originalDialog = dialog.showOpenDialog
    const probe: PhotoProbe = { calls: [], failures: [], restore() { for (const { channel, handler } of originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }; dialog.showOpenDialog = originalDialog; delete host.task071PhotoProbe } }
    host.task071PhotoProbe = probe
    for (const { channel, handler } of originals) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        // 先执行原入口，保持可信Renderer、请求验证与Core真实读取；只在指定响应处丢弃一次结果。
        const result = await handler(...args), id = args[1]
        if (typeof id !== 'string') throw new Error('照片探针只接受正式照片编号')
        probe.calls.push({ channel, id })
        if (probe.armed?.channel === channel && probe.armed.id === id) {
          probe.armed = undefined; probe.failures.push({ channel, id })
          throw new Error('[INVENTORY_UNAVAILABLE] 合成单图读取失败')
        }
        return result
      })
    }
  })
  try {
    const files: { filename: string; bytes: Buffer; image: CollectionPhotoImage }[] = []
    for (const [width, height] of [[320, 160], [160, 320]] as const) {
      const bytes = Buffer.from(await app.evaluate(({ nativeImage }, size) => {
        const bitmap = Buffer.alloc(size.width * size.height * 4)
        for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
          const index = (y * size.width + x) * 4
          bitmap[index] = x < size.width / 2 ? 50 : 190; bitmap[index + 1] = y < size.height / 2 ? 130 : 210; bitmap[index + 2] = 160; bitmap[index + 3] = 255
        }
        return Array.from(nativeImage.createFromBitmap(bitmap, size).toPNG())
      }, { width, height }))
      const filename = path.join(directory, `task071-synthetic-${width}x${height}.png`)
      await writeFile(filename, bytes)
      await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }) }, filename)
      const image = await page.evaluate(() => window.musicBridge.pickCollectionPhoto())
      expect(image).not.toBeNull(); expect(image).toMatchObject({ width, height })
      files.push({ filename, bytes, image: image! })
    }
    const models: { id: string; photoId?: string; name: string }[] = [], releases: { id: string; photoId?: string; title: string }[] = []
    // 型号按新增倒序，原版按标题排序；逆序建资料，使两面板均从00到11展示。
    for (let index = 11; index >= 0; index--) {
      const name = `${String(index).padStart(2, '0')}-${index === 11 ? 'L'.repeat(117) : '合成长型号'}`
      const received = await page.evaluate(request => window.musicBridge.receiveCollectionStock(request), {
        commandId: randomUUID(), model: { brand: '照片071', name, edition: '合成版次'.repeat(20), year: 1990, format: 'cassette' as const, tapeType: 'II' as const, identification: 'verified' as const }, lengthMinutes: 90,
        quantities: { sealedBlank: 0, openedBlank: 2, legacyUsed: 0, unclassified: 0 }
      })
      const image = files[index % 2]!.image
      const added = index === 1 ? undefined : await page.evaluate(request => window.musicBridge.addCollectionPhoto(request), { commandId: randomUUID(), modelId: received.modelId, image })
      models[index] = { id: received.modelId, name, ...(added?.photoId ? { photoId: added.photoId } : {}) }
      const title = (`照片071-${String(index).padStart(2, '0')}-` + (index === 11 ? 'LongTitle'.repeat(30) : '合成长标题'.repeat(35))).slice(0, 240)
      const release = await page.evaluate(request => window.musicBridge.savePhysicalRelease(request), {
        commandId: randomUUID(), release: { title, artist: '合成作者'.repeat(30), format: 'cd' as const, quantity: 1, completeness: 'basic' as const, edition: '独立合成版次', tracks: [] }
      })
      const addedRelease = index === 1 ? undefined : await page.evaluate(request => window.musicBridge.addPhysicalMusicPhoto(request), { commandId: randomUUID(), id: release.id, image })
      releases[index] = { id: release.id, title, ...(addedRelease?.photoId ? { photoId: addedRelease.photoId } : {}) }
    }
    const inventory = async () => page.evaluate(async ids => Promise.all(ids.map(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }))), models.map(model => model.id))
    const physical = async () => page.evaluate(async ids => Promise.all(ids.map(id => window.musicBridge.getPhysicalMusic(id))), releases.map(release => release.id))
    const beforeInventory = await inventory(), beforePhysical = await physical()
    expect(beforeInventory.reduce((sum, item) => sum + item.model.counts.total, 0)).toBe(24)
    expect(beforeInventory.reduce((sum, item) => sum + (item.photos?.length ?? 0), 0)).toBe(11)
    expect(beforePhysical.reduce((sum, item) => sum + item.photos.length, 0)).toBe(11)
    const reads = (channel: PhotoChannel, id: string) => app.evaluate((_electron, input) => (globalThis as typeof globalThis & { task071PhotoProbe: PhotoProbe }).task071PhotoProbe.calls.filter(call => call.channel === input.channel && call.id === input.id).length, { channel, id })
    const failNext = (channel: PhotoChannel, id: string) => app.evaluate((_electron, input) => {
      const probe = (globalThis as typeof globalThis & { task071PhotoProbe: PhotoProbe }).task071PhotoProbe
      if (probe.armed) throw new Error('上次单次故障尚未命中')
      probe.armed = input
    }, { channel, id })
    async function layout(scope: Locator): Promise<void> {
      expect(await page.locator('.content-scroll').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      expect(await scope.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      expect(await scope.locator('button button').count()).toBe(0)
      await page.evaluate(source => window.eval(source), axe)
      const serious = await scope.evaluate(async element => {
        const result = await (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { id: string; impact: string | null }[] }> } }).axe.run(element)
        return result.violations.filter(item => item.impact === 'critical' || item.impact === 'serious')
      })
      expect(serious).toEqual([])
    }
    async function dimensions(img: Locator, width: number, height: number): Promise<void> {
      await expect.poll(() => img.evaluate(element => ({ width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight }))).toEqual({ width, height })
      expect(await img.evaluate(element => getComputedStyle(element).objectFit)).toBe('contain')
      await expect(img).toHaveAttribute('width', String(width)); await expect(img).toHaveAttribute('height', String(height))
    }
    await page.setViewportSize({ width: 720, height: 480 })
    await page.locator('[data-sidebar-source="collection"]').click()
    for (const kind of ['collection', 'physical'] as const) {
      const isCollection = kind === 'collection', channel: PhotoChannel = isCollection ? 'collection:photo' : 'physicalMusic:photo'
      await page.setViewportSize({ width: 720, height: 480 })
      await page.getByRole('tab', { name: isCollection ? '空白磁带收藏' : '实体音乐库', exact: true }).click()
      const wall = page.locator(isCollection ? '#collection-panel-tapes' : '.music-library')
      const cards = wall.locator(isCollection ? '.inventory-card' : '.music-card')
      await expect(cards).toHaveCount(12)
      const target = isCollection ? models[11]! : releases[11]!, photoId = target.photoId!
      const card = cards.filter({ has: page.locator(`[data-photo-id="${photoId}"]`) }), thumbnail = card.locator('.collection-photo')
      await expect(card).toHaveCount(1)
      expect(await card.evaluate(element => element.getBoundingClientRect().top > window.innerHeight + 200)).toBe(true)
      await expect(thumbnail).toHaveAttribute('data-photo-state', 'idle')
      expect(await reads(channel, photoId)).toBe(0)
      // 首项可能仍被标题/筛选区挤出滚动视口；先明确滚入首张缩略图，不把列表顺序当作可视证据。
      const firstId = (isCollection ? models[0]! : releases[0]!).photoId!
      const firstThumbnail = wall.locator(`[data-photo-id="${firstId}"]`)
      await firstThumbnail.scrollIntoViewIfNeeded()
      await expect(firstThumbnail).toBeInViewport()
      await expect(firstThumbnail).toHaveAttribute('data-photo-state', 'ready')
      expect(await card.evaluate(element => element.getBoundingClientRect().top > window.innerHeight + 200)).toBe(true)
      await expect(thumbnail).toHaveAttribute('data-photo-state', 'idle')
      expect(await reads(channel, photoId)).toBe(0)
      await expect(cards.filter({ hasText: isCollection ? models[1]!.name : releases[1]!.title }).getByText('实物照片待添加', { exact: true })).toBeVisible()
      await failNext(channel, photoId)
      await card.scrollIntoViewIfNeeded()
      await expect(thumbnail).toHaveAttribute('data-photo-state', 'failed')
      await expect(card.getByText('照片读取失败，可打开大图重试', { exact: true })).toBeVisible()
      expect(await reads(channel, photoId)).toBe(1)
      await layout(wall)
      await page.screenshot({ path: outputPath(`task071-${kind}-photo-wall-720.png`) })
      await card.press('Enter')
      const photos = page.getByRole('region', { name: isCollection ? '实物照片' : '发行版实物照片', exact: true })
      const open = photos.getByRole('button', { name: isCollection ? '查看实物照片 1' : '查看发行版照片 1', exact: true })
      await open.scrollIntoViewIfNeeded()
      await expect(open.locator('.collection-photo')).toHaveAttribute('data-photo-state', 'ready')
      // 卡片和新大图是两次独立读取；各只丢弃一次响应，恢复必须由明确单图重试触发。
      await failNext(channel, photoId)
      await open.press('Enter')
      const viewer = page.getByRole('dialog', { name: isCollection ? '实物照片大图' : '发行版照片大图', exact: true })
      await expect(viewer).toBeVisible()
      await expect(viewer.locator('.collection-photo')).toHaveAttribute('data-photo-state', 'failed')
      const failedReads = await reads(channel, photoId)
      const retry = viewer.getByRole('button', { name: '重试此照片', exact: true })
      await retry.focus(); await retry.press('Enter')
      await expect(viewer.locator('.collection-photo')).toHaveAttribute('data-photo-state', 'ready')
      expect(await reads(channel, photoId)).toBe(failedReads + 1)
      await dimensions(viewer.locator('img'), 160, 320)
      for (const size of [{ width: 720, height: 480 }, { width: 1440, height: 900 }]) {
        await page.setViewportSize(size); await layout(viewer)
      }
      await page.screenshot({ path: outputPath(`task071-${kind}-photo-dialog-1440.png`) })
      await page.keyboard.press('Escape'); await expect(viewer).not.toBeVisible(); await expect(open).toBeFocused()
      await layout(wall)
      await page.getByRole('button', { name: isCollection ? '← 返回收藏' : '← 返回音乐库', exact: true }).click()
      await expect(cards).toHaveCount(12)
      const first = cards.filter({ has: page.locator(`[data-photo-id="${firstId}"]`) })
      await first.scrollIntoViewIfNeeded(); await dimensions(first.locator('img'), 320, 160)
      await layout(wall)
    }
    expect(await inventory()).toEqual(beforeInventory)
    expect(await physical()).toEqual(beforePhysical)
    for (const file of files) expect(await readFile(file.filename)).toEqual(file.bytes)
    const observed = await app.evaluate(() => {
      const probe = (globalThis as typeof globalThis & { task071PhotoProbe: PhotoProbe }).task071PhotoProbe
      return { failures: probe.failures, armed: probe.armed ?? null }
    })
    expect(observed.armed).toBeNull()
    expect(observed.failures).toEqual([
      { channel: 'collection:photo', id: models[11]!.photoId }, { channel: 'collection:photo', id: models[11]!.photoId },
      { channel: 'physicalMusic:photo', id: releases[11]!.photoId }, { channel: 'physicalMusic:photo', id: releases[11]!.photoId }
    ])
    expect((await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('idle')
  } finally {
    await app.evaluate(() => (globalThis as typeof globalThis & { task071PhotoProbe?: PhotoProbe }).task071PhotoProbe?.restore())
  }
}
