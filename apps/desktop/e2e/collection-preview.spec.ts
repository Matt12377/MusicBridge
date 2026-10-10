import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CanonicalReference } from '@music-bridge/contracts'
import { e2eTemporaryRoot } from './temporary-root.js'
import { waitForMainWindow } from './main-window.js'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const longName = '超长型号名称用于验证完整品牌型号仍可辨认以及窄窗口能够换行'.repeat(3)
let app: ElectronApplication | undefined
let page: Page
let userData: string

async function setContentSize(width: number, height: number): Promise<void> {
  const bounds = await app!.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('musicbridge://app/'))
    if (!window) throw new Error('正式应用主窗口未找到')
    window.setContentSize(size.width, size.height)
    return window.getContentBounds()
  }, { width, height })
  expect({ width: bounds.width, height: bounds.height }).toEqual({ width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}

async function openCollection(): Promise<void> {
  await page.locator('[data-sidebar-source="collection"]').click()
  await expect(page.getByRole('navigation', { name: '磁带收藏内容', exact: true })).toBeVisible()
  await expect(page.locator('.collection-add')).toBeEnabled()
}

async function seedCollection(blankCount = 29): Promise<void> {
  await page.evaluate(async ({ count, name }) => {
    // 所有记录通过正式 IPC 和隔离 Core 写入，不替换 Renderer 列表或真实用户资料。
    for (let index = 0; index < count + 5; index++) {
      const needsReview = index >= count && index < count + 3
      const recorded = index >= count + 3
      const result = await window.musicBridge.receiveCollectionStock({ commandId: crypto.randomUUID(), model: {
        brand: needsReview ? '合成待核品牌' : recorded ? '合成录音品牌' : '合成收藏品牌',
        name: index === 0 ? name : `合成型号 ${String(index).padStart(2, '0')}`,
        edition: needsReview ? '' : '隔离回归版', year: needsReview ? null : index < 10 ? 1991 : 2001,
        format: 'cassette', tapeType: needsReview ? 'unknown' : 'II', identification: needsReview ? 'unidentified' : 'verified',
      }, lengthMinutes: needsReview ? null : 90, quantities: {
        sealedBlank: !needsReview && !recorded ? 2 : 0, openedBlank: 0,
        legacyUsed: recorded ? 1 : 0, unclassified: needsReview ? 1 : 0,
      } })
      if (recorded) await window.musicBridge.materializeCollectionCopy({ commandId: crypto.randomUUID(), lotId: result.lotId!, bucket: 'legacyUsed', action: 'register-legacy' })
    }
  }, { count: blankCount, name: longName })
}

async function filterState(state: string): Promise<void> {
  const form = page.getByRole('form', { name: '筛选磁带收藏' })
  await form.getByRole('combobox', { name: '收藏状态', exact: true }).selectOption(state)
  await form.getByRole('button', { name: '筛选', exact: true }).click()
}

async function seedReferenceImage(): Promise<void> {
  const item: CanonicalReference = { referenceId: 'preview-synthetic-reference', bookId: 'preview-synthetic-book',
    brand: '合成收藏品牌', model: '合成型号 01', series: '合成系列', edition: '隔离回归版', lengths: [90], iec: 'II',
    era: '1991', image: { kind: 'none' }, pages: ['1'], notes: '合成参考图，仅用于自动验证', confidence: 'high' }
  const rawPack = JSON.stringify({ schemaVersion: 1, bookId: item.bookId, title: '合成参考资料', sourceVersion: '回归版', items: [item] })
  const packHash = createHash('sha256').update(rawPack).digest('hex')
  await page.evaluate(async ({ sourceText, hash, reference }) => {
    const source = await window.musicBridge.registerReferenceSource({ commandId: crypto.randomUUID(), rawPack: sourceText, packHash: hash, userConfirmed: true })
    const canvas = document.createElement('canvas')
    canvas.width = 160; canvas.height = 100
    const context = canvas.getContext('2d')!
    context.fillStyle = '#527567'; context.fillRect(0, 0, canvas.width, canvas.height)
    const illustrated: CanonicalReference = { ...reference, image: { kind: 'reference', caption: '合成目录参考图', image: {
      dataUrl: canvas.toDataURL('image/jpeg'), width: canvas.width, height: canvas.height,
    } } }
    const request = { sourceId: source.id, expectedCurrentRevisionId: null, items: [illustrated], mappings: [] }
    const preview = await window.musicBridge.previewCatalogRevision(request)
    await window.musicBridge.publishCatalogRevision({ ...request, commandId: crypto.randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true })
  }, { sourceText: rawPack, hash: packHash, reference: item })
}

async function assertNoHorizontalOverflow(): Promise<void> {
  const geometry = await page.evaluate(() => {
    const collection = document.querySelector<HTMLElement>('.collection-view')!
    const root = document.documentElement
    const rect = collection.getBoundingClientRect()
    return { windowWidth: innerWidth, rootClient: root.clientWidth, rootScroll: root.scrollWidth,
      collectionClient: collection.clientWidth, collectionScroll: collection.scrollWidth, left: rect.left, right: rect.right }
  })
  expect(geometry.rootScroll).toBeLessThanOrEqual(geometry.rootClient + 1)
  expect(geometry.collectionScroll).toBeLessThanOrEqual(geometry.collectionClient + 1)
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.windowWidth + 1)
}

/** 当前全宽墙按容器宽度响应；验证真实行列、间距和完整图片，不固定桌面列数。 */
async function assertCollectionWallGeometry(): Promise<void> {
  const grid = page.locator('.inventory-grid')
  await expect(grid).toBeVisible()
  const geometry = await grid.evaluate(element => {
    const collection = element.closest<HTMLElement>('.collection-view')!, scroll = collection.closest<HTMLElement>('.content-scroll')!
    const collectionStyle = getComputedStyle(collection), scrollStyle = getComputedStyle(scroll), style = getComputedStyle(element)
    const boxes = [...element.querySelectorAll<HTMLElement>('.inventory-tile')].map(tile => { const box = tile.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, right: box.right } })
    const media = [...element.querySelectorAll<HTMLElement>('.inventory-card-media')].map(item => { const box = item.getBoundingClientRect(); return { width: box.width, height: box.height } })
    const images = [...element.querySelectorAll<HTMLImageElement>('.inventory-card-photo img')].map(image => {
      const box = image.getBoundingClientRect(), frame = image.closest<HTMLElement>('.inventory-card-media')!.getBoundingClientRect()
      return { fit: getComputedStyle(image).objectFit, width: image.naturalWidth, height: image.naturalHeight,
        left: box.left - frame.left, top: box.top - frame.top, right: box.right - frame.right, bottom: box.bottom - frame.bottom }
    })
    return { collectionWidth: collection.getBoundingClientRect().width,
      availableWidth: scroll.clientWidth - parseFloat(scrollStyle.paddingLeft) - parseFloat(scrollStyle.paddingRight),
      containerWidth: collection.clientWidth - parseFloat(collectionStyle.paddingLeft) - parseFloat(collectionStyle.paddingRight),
      gridWidth: element.clientWidth, columns: style.gridTemplateColumns.split(/\s+/u).length, gap: parseFloat(style.columnGap), boxes, media, images }
  })
  expect(geometry.collectionWidth).toBeCloseTo(geometry.availableWidth, 0)
  const gap = geometry.containerWidth <= 820 ? 20 : 28
  const columns = geometry.containerWidth <= 480 ? 1 : geometry.containerWidth <= 820 ? 2 : Math.max(1, Math.floor((geometry.gridWidth + gap) / (280 + gap)))
  expect(geometry.columns).toBe(columns)
  expect(geometry.gap).toBe(gap)
  expect(geometry.boxes.length).toBeGreaterThan(0)
  const firstRow = geometry.boxes.slice(0, columns)
  for (const [index, box] of firstRow.entries()) {
    expect(box.y).toBeCloseTo(firstRow[0]!.y, 0)
    expect(box.width).toBeCloseTo(firstRow[0]!.width, 0)
    if (index) expect(box.x - firstRow[index - 1]!.right).toBeCloseTo(gap, 0)
  }
  if (geometry.boxes.length > columns) expect(geometry.boxes[columns]!.y).toBeGreaterThan(firstRow[0]!.y)
  for (const media of geometry.media) expect(media.width / media.height).toBeCloseTo(8 / 5, 2)
  for (const image of geometry.images) {
    expect(image.fit).toBe('contain')
    expect(image.width).toBeGreaterThan(0); expect(image.height).toBeGreaterThan(0)
    expect(image.left).toBeGreaterThanOrEqual(-1); expect(image.top).toBeGreaterThanOrEqual(-1)
    expect(image.right).toBeLessThanOrEqual(1); expect(image.bottom).toBeLessThanOrEqual(1)
  }
}

async function capture(name: string): Promise<void> {
  await assertNoHorizontalOverflow()
  if (await page.locator('.inventory-grid').isVisible()) await assertCollectionWallGeometry()
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), scale: 'css', animations: 'disabled' })
  const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme,
    cards: [...document.querySelectorAll('.inventory-card')].map(card => { const box = card.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height } }) }))
  await writeFile(test.info().outputPath(`${name}-geometry.json`), `${JSON.stringify(geometry, null, 2)}\n`)
}

test.beforeEach(async () => {
  test.setTimeout(180_000)
  userData = await mkdtemp(path.join(e2eTemporaryRoot(), 'musicbridge-ui-e2e-collection-preview-'))
  await mkdir(test.info().outputDir, { recursive: true })
  await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), userData)
  const assets = await readdir(path.join(desktopRoot, 'dist/renderer/assets'))
  const renderer = assets.filter(file => /^index-.*\.js$/u.test(file))
  const stylesheet = assets.filter(file => /^index-.*\.css$/u.test(file))
  expect(renderer).toHaveLength(1)
  expect(stylesheet).toHaveLength(1)
  const bundles = ['dist/main/index.js', 'dist/main/core.js', 'dist/preload/index.cjs', 'dist/renderer/index.html', `dist/renderer/assets/${renderer[0]}`, `dist/renderer/assets/${stylesheet[0]}`]
  const identity = Object.fromEntries(await Promise.all(bundles.map(async file => [file, createHash('sha256').update(await readFile(path.join(desktopRoot, file))).digest('hex')])))
  await writeFile(test.info().outputPath('bundle-identity.json'), `${JSON.stringify(identity, null, 2)}\n`)
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  app = await electron.launch({ timeout: 45_000, args: testElectronArguments([path.join(desktopRoot, 'dist/main/index.js')], 'mock'), cwd: desktopRoot,
    env: { ...inherited, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: userData } })
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  page = await waitForMainWindow(app)
  page.setDefaultTimeout(15_000)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userData)
  await setContentSize(1440, 900)
})

test.afterEach(async () => {
  const running = app
  app = undefined
  try {
    if (running) {
      const network = await running.evaluate(() => (globalThis as typeof globalThis & {
        __musicBridgeUiE2eNetworkEvidence?: { installedBeforeWindow: boolean; blockedExternalAttempts: number; blockedHosts: string[] }
      }).__musicBridgeUiE2eNetworkEvidence)
      expect(network).toMatchObject({ installedBeforeWindow: true, blockedExternalAttempts: 0, blockedHosts: [] })
      await writeFile(test.info().outputPath('offline-network-evidence.json'), `${JSON.stringify(network, null, 2)}\n`)
      await running.context().tracing.stop({ path: test.info().outputPath('collection-preview-trace.zip') })
    }
  } finally { await running?.close() }
})

test('收藏原型：状态筛选跨分页、墙与库存切换以及详情返回保留真实结果', async () => {
  await seedCollection()
  await openCollection()
  await expect(page.locator('.inventory-card')).toHaveCount(24)
  const totals = await page.evaluate(async () => {
    const result: Record<string, number> = {}
    for (const stockState of ['blank', 'needs-review', 'identified', 'recorded'] as const) {
      const collection = await window.musicBridge.listCollection({ offset: 0, limit: 24 }, { stockState })
      result[stockState] = collection.total
      if (stockState === 'blank' && collection.items.some(model => model.counts.unknown || model.counts.recorded)) throw new Error('未知或已录库存错误进入空白筛选')
    }
    return result
  })
  expect(totals).toEqual({ blank: 29, 'needs-review': 3, identified: 31, recorded: 2 })
  await writeFile(test.info().outputPath('stock-state-totals.json'), `${JSON.stringify(totals, null, 2)}\n`)

  await filterState('blank')
  const pagination = page.getByRole('navigation', { name: '收藏分页', exact: true })
  await expect(page.locator('.inventory-card')).toHaveCount(24)
  await expect(page.locator('.collection-list-tools')).toContainText('筛选结果 · 29 个型号')
  await expect(pagination).toContainText('1 / 2')
  const firstPageTitles = await page.locator('.inventory-card-title').allTextContents()
  await pagination.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('.inventory-card')).toHaveCount(5)
  await expect(pagination).toContainText('2 / 2')
  const secondPageTitles = await page.locator('.inventory-card-title').allTextContents()
  expect(new Set([...firstPageTitles, ...secondPageTitles]).size).toBe(29)
  await page.locator('.inventory-card').first().click()
  await expect(page.getByRole('region', { name: '磁带型号详情' }).getByRole('heading', { name: secondPageTitles[0], exact: true })).toBeVisible()
  await page.getByRole('button', { name: '← 返回收藏', exact: true }).click()
  await expect(page.locator('.inventory-card-title')).toHaveText(secondPageTitles)
  await expect(pagination).toContainText('2 / 2')

  const navigation = page.getByRole('navigation', { name: '磁带收藏内容', exact: true })
  await navigation.getByRole('button', { name: '我的库存', exact: true }).click()
  const inventory = page.getByRole('table', { name: '磁带库存', exact: true })
  await expect(inventory).toBeVisible()
  await expect(inventory.getByRole('row')).toHaveCount(6)
  for (const title of secondPageTitles) await expect(inventory).toContainText(title.trim())
  await expect(page.getByRole('combobox', { name: '收藏状态', exact: true })).toHaveValue('blank')
  await navigation.getByRole('button', { name: '磁带墙', exact: true }).click()
  await expect(page.locator('.inventory-card-title')).toHaveText(secondPageTitles)

  await filterState('needs-review')
  await expect(page.locator('.inventory-card')).toHaveCount(3)
  await expect(page.locator('.collection-list-tools')).toContainText('筛选结果 · 3 个型号')
  await expect(page.locator('.inventory-card').first()).toContainText('尚待核实')
  await expect(pagination).toHaveCount(0)
  await filterState('recorded')
  await expect(page.locator('.inventory-card')).toHaveCount(2)
  await expect(page.locator('.collection-list-tools')).toContainText('筛选结果 · 2 个型号')
  await expect(page.locator('.inventory-card').first()).toContainText('已收藏')
  await filterState('identified')
  await expect(page.locator('.inventory-card')).toHaveCount(24)
  await expect(page.locator('.collection-list-tools')).toContainText('筛选结果 · 31 个型号')
  await expect(pagination).toContainText('1 / 2')
  const filters = page.getByRole('form', { name: '筛选磁带收藏' })
  await page.getByRole('textbox', { name: '关键词', exact: true }).fill('合成型号')
  await filters.getByRole('combobox', { name: '品牌', exact: true }).fill('合成收藏品牌')
  await filters.getByRole('combobox', { name: '年代', exact: true }).selectOption('1990')
  await filters.getByRole('button', { name: '筛选', exact: true }).click()
  await expect(page.locator('.inventory-card')).toHaveCount(9)
  await expect(page.locator('.collection-list-tools')).toContainText('筛选结果 · 9 个型号')
  await expect(pagination).toHaveCount(0)
  await expect(page.locator('.inventory-card-title')).toHaveText(Array.from({ length: 9 }, (_, index) => `合成收藏品牌 合成型号 ${String(9 - index).padStart(2, '0')}`))
})

test('收藏原型：浅深色全宽响应式墙、720 窄窗长型号、滚动入口与实体音乐仍可使用', async () => {
  await seedCollection(4)
  await seedReferenceImage()
  await openCollection()
  const cards = page.locator('.inventory-card')
  await expect(cards).toHaveCount(9)
  const longCard = cards.filter({ has: page.locator('.inventory-card-title', { hasText: longName }) })
  await expect(longCard.locator('.inventory-card-title')).toHaveText(`合成收藏品牌 ${longName}`)
  await expect(longCard).toContainText('线稿占位 · 非实物照片')
  const referenceCard = cards.filter({ has: page.locator('.inventory-card-title', { hasText: '合成收藏品牌 合成型号 01' }) })
  await expect(referenceCard).toContainText('书籍参考 · 版次未核')
  await expect(referenceCard.getByRole('img', { name: /原书资料参考图，非我的实物照片/u })).toBeVisible()
  const referenceImage = referenceCard.getByRole('img', { name: /原书资料参考图，非我的实物照片/u })
  await expect.poll(() => referenceImage.evaluate(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight }))).toEqual({ width: 160, height: 100 })
  await assertCollectionWallGeometry()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await capture('collection-wall-light-1440')
  await referenceCard.locator('.reference-image img').dispatchEvent('error')
  await expect(referenceCard).toContainText('参考图读取失败，请重新读取目录')
  await expect(referenceCard).toContainText('书籍参考 · 版次未核')
  expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 100 }))).total).toBe(9)

  await page.getByRole('button', { name: '打开设置', exact: true }).click()
  await page.getByRole('tab', { name: '应用', exact: true }).click()
  await page.getByRole('radio', { name: /深色/u }).check()
  await openCollection()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('appearance-changing'))).toBe(false)
  await capture('collection-wall-dark-1440')
  await setContentSize(720, 900)
  await capture('collection-wall-dark-720')
  await expect(longCard.locator('.inventory-card-title')).toHaveText(`合成收藏品牌 ${longName}`)
  await longCard.scrollIntoViewIfNeeded()
  await expect(longCard).toBeInViewport()
  await capture('collection-long-title-bottom-dark-720')
  // 卡片仅显示型号、年代和状态；求购从页面既有入口管理。
  await page.getByRole('button', { name: '完成度与求购', exact: true }).click()
  const wants = page.getByRole('dialog', { name: '完成度与求购', exact: true })
  await wants.getByRole('navigation', { name: '完成度与求购内容' }).getByRole('button', { name: '求购清单', exact: true }).click()
  await expect(wants.getByRole('navigation', { name: '完成度与求购内容' }).getByRole('button', { name: '求购清单', exact: true })).toHaveAttribute('aria-current', 'page')
  await wants.getByRole('button', { name: '关闭', exact: true }).click()
  await cards.filter({ hasText: '合成录音品牌' }).first().click()
  const detail = page.getByRole('region', { name: '磁带型号详情' })
  await expect(detail).toBeVisible()
  const detailTabs = detail.getByRole('tablist', { name: '型号详情页面', exact: true })
  // 顶层两库是侧栏按钮；真正的详情 tab 继续保护箭头与首尾键盘合同。
  const overviewTab = detailTabs.getByRole('tab', { name: '概览', exact: true })
  await overviewTab.focus()
  for (const [key, label] of [['ArrowRight', '我的库存'], ['End', '资料照片'], ['Home', '概览'], ['ArrowLeft', '资料照片']] as const) {
    await page.keyboard.press(key)
    const tab = detailTabs.getByRole('tab', { name: label, exact: true })
    await expect(tab).toBeFocused()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(detail.getByRole('tabpanel', { name: label, exact: true })).toBeVisible()
  }
  for (const label of ['概览', '我的库存', '资料照片', '实体磁带']) {
    await detailTabs.getByRole('tab', { name: label, exact: true }).click()
    await expect(detail.getByRole('tabpanel')).toHaveCount(1)
    await expect(detail.getByRole('tabpanel', { name: label, exact: true })).toBeVisible()
  }
  const bottomAction = detail.getByRole('button', { name: '标为不可用', exact: true }).last()
  await bottomAction.scrollIntoViewIfNeeded()
  await expect(bottomAction).toBeInViewport()
  await expect(bottomAction).toBeEnabled()
  await capture('collection-detail-bottom-dark-720')
  await detail.getByRole('button', { name: '← 返回收藏', exact: true }).click()
  await assertNoHorizontalOverflow()

  await page.getByRole('button', { name: '添加磁带', exact: true }).click()
  const receive = page.getByRole('dialog', { name: '添加磁带', exact: true })
  await expect(receive.getByRole('button', { name: '保存库存', exact: true })).toBeEnabled()
  await receive.getByRole('button', { name: '关闭录入', exact: true }).click()
  for (const [button, title] of [['库存表导入', '库存表非破坏导入'], ['参考目录与版次', '参考目录与版次'], ['完成度与求购', '完成度与求购']] as const) {
    await page.getByRole('button', { name: button, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: title, exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  }
  await page.getByRole('group', { name: '实物收藏分类', exact: true }).getByRole('button', { name: '实体音乐库', exact: true }).click()
  const music = page.getByRole('region', { name: '实体音乐库内容' })
  await expect(music.getByRole('button', { name: '添加实体音乐', exact: true })).toBeEnabled()
  await expect(music.locator('.music-card')).toHaveCount(2)
  await music.getByRole('button', { name: '添加实体音乐', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '添加实体音乐', exact: true })
  await expect(editor).toBeVisible()
  await editor.getByRole('button', { name: '关闭音乐录入', exact: true }).click()
  await page.getByRole('group', { name: '实物收藏分类', exact: true }).getByRole('button', { name: '收藏音乐库', exact: true }).click()
  await expect(cards).toHaveCount(9)
  expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 100 }))).total).toBe(9)
})
