import { _electron as electron, expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { verifiedElectronExecution } from '../scripts/electron-identity.mjs'
import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { e2eTemporaryRoot } from './temporary-root.js'
import { waitForMainWindow } from './main-window.js'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** 自建非零双声道PCM及RIFF标题；只用于本次隔离库的真实只读扫描。 */
function wave(title: string): Buffer {
  const pcm = Buffer.alloc(512 * 4)
  for (let n = 0; n < 512; n++) { pcm.writeInt16LE((n % 31) * 103 + 1, n * 4); pcm.writeInt16LE(-((n % 17) * 127 + 1), n * 4 + 2) }
  const text = Buffer.from(title + '\0'), pad = Buffer.alloc(text.length % 2)
  const entry = Buffer.alloc(8); entry.write('INAM'); entry.writeUInt32LE(text.length, 4)
  const listBody = Buffer.concat([Buffer.from('INFO'), entry, text, pad])
  const list = Buffer.alloc(8); list.write('LIST'); list.writeUInt32LE(listBody.length, 4)
  const format = Buffer.alloc(24); format.write('fmt '); format.writeUInt32LE(16, 4)
  format.writeUInt16LE(1, 8); format.writeUInt16LE(2, 10); format.writeUInt32LE(44100, 12)
  format.writeUInt32LE(44100 * 4, 16); format.writeUInt16LE(4, 20); format.writeUInt16LE(16, 22)
  const data = Buffer.alloc(8); data.write('data'); data.writeUInt32LE(pcm.length, 4)
  const body = Buffer.concat([Buffer.from('WAVE'), format, data, pcm, list, listBody])
  const riff = Buffer.alloc(8); riff.write('RIFF'); riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

test('009正式离线App复用Node扫描、原导航与共享表格；仅显示更正不改源字节', async () => {
  test.setTimeout(120_000)
  const temporaryRoot = e2eTemporaryRoot()
  const run = await mkdtemp(path.join(temporaryRoot, 'mbrs009-ui-'))
  const profile = await mkdtemp(path.join(temporaryRoot, 'musicbridge-ui-e2e-009-'))
  const source = path.join(run, 'synthetic-audio')
  await mkdir(source)
  const names = ['009 UI Studio.wav', '009 UI Live.wav', '009 UI Remaster.wav']
  const before: Record<string, string> = {}
  for (const name of names) {
    const bytes = wave(name.slice(0, -4)); await writeFile(path.join(source, name), bytes, {flag: 'wx', mode: 0o600})
    before[name] = sha256(bytes)
  }
  // 官方身份在启动前核对现树；只窄替换原生picker结果，不替换IPC、扫描器或Renderer。
  const identity = verifiedElectronExecution()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  Object.assign(env, {MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1',
    MUSIC_BRIDGE_TEST_KEYCHAIN_MODE: 'mock', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profile})
  const app = await electron.launch({executablePath: path.join(identity.packageRoot, 'dist', 'Electron.app/Contents/MacOS/Electron'),
    args: testElectronArguments([path.join(desktopRoot, 'dist/main/index.js')], 'mock'), cwd: desktopRoot, env})
  try {
    const page = await waitForMainWindow(app)
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.locator('[data-sidebar-source="local-library"]').click()
    const view = page.getByTestId('local-library-view')
    await expect(view.getByText('本地音乐库还没有曲目', {exact: true})).toBeVisible()
    await view.locator('.local-library-management > summary').click()
    await app.evaluate(({dialog}, selected) => {
      dialog.showOpenDialog = (async () => ({canceled: false, filePaths: [selected]})) as typeof dialog.showOpenDialog
    }, source)
    await view.getByRole('button', {name: '授权源目录并加入音乐库', exact: true}).click()
    await expect(view.getByRole('button', {name: '增量扫描', exact: true})).toBeEnabled()
    await view.getByRole('button', {name: '增量扫描', exact: true}).click()
    await expect(view.getByRole('list', {name: '扫描任务'})).toContainText('已完成', {timeout: 45_000})
    await expect(view.locator('.local-results-summary')).toContainText('3 首', {timeout: 10_000})
    const input = view.getByRole('searchbox', {name: '搜索曲目、艺术家、专辑与已有版本', exact: true})
    await input.fill('009 UI Live'); await input.press('Enter')
    await expect(view.locator('.local-results-summary')).toContainText('1 首')
    await view.locator('.local-library-management > summary').click()
    const table = view.getByRole('table', {name: '歌曲列表', exact: true})
    await expect(table.getByRole('columnheader')).toHaveCount(3)
    await expect(table.getByRole('cell')).toHaveCount(3)
    const dimensions = []
    // 这是自动化生产DOM几何辅助，另由Root使用CUA验证普通操作。
    for (const width of [720, 780, 800, 801, 1024]) {
      await app.evaluate(({BrowserWindow}, nextWidth) => {
        const windows = BrowserWindow.getAllWindows().filter(window => window.webContents.getURL() === 'musicbridge://app/index.html')
        if (windows.length !== 1) throw new Error('无法精确识别本次测试窗口。')
        windows[0]!.setContentSize(nextWidth, 900)
      }, width)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
      const geometry = await table.locator('.track-row:not(.track-row-placeholder)').first().evaluate(element => {
        const rect = (target: Element) => {
          const box = target.getBoundingClientRect()
          return {left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height}
        }
        const copy = element.querySelector('.track-copy')
        const actions = element.querySelector('.row-actions')
        if (!copy || !actions) throw new Error('缺少曲目正文或原行动作入口。')
        return {viewportWidth: window.innerWidth, row: rect(element), copy: rect(copy), actions: rect(actions),
          buttons: [...actions.querySelectorAll('button')].map(rect)}
      })
      expect(Math.abs(geometry.row.height - 84)).toBeLessThan(0.5)
      expect(geometry.copy.width).toBeGreaterThan(0)
      expect(geometry.copy.right).toBeLessThanOrEqual(geometry.actions.left + 0.5)
      expect(geometry.actions.width).toBeGreaterThanOrEqual(142)
      expect(geometry.actions.right).toBeLessThanOrEqual(geometry.row.right + 0.5)
      expect(geometry.buttons).toHaveLength(3)
      for (let index = 0; index < geometry.buttons.length; index++) {
        const button = geometry.buttons[index]!
        expect(button.width).toBeGreaterThanOrEqual(44)
        expect(button.height).toBeGreaterThanOrEqual(44)
        expect(button.left).toBeGreaterThanOrEqual(geometry.actions.left - 0.5)
        expect(button.right).toBeLessThanOrEqual(geometry.actions.right + 0.5)
        if (index > 0) expect(button.left).toBeGreaterThanOrEqual(geometry.buttons[index - 1]!.right)
      }
      dimensions.push(geometry)
      await page.screenshot({path: test.info().outputPath(`009-table-${width}px.png`)})
    }
    await app.evaluate(({BrowserWindow}) => {
      const windows = BrowserWindow.getAllWindows().filter(window => window.webContents.getURL() === 'musicbridge://app/index.html')
      if (windows.length !== 1) throw new Error('无法精确识别本次测试窗口。')
      windows[0]!.setContentSize(960, 640)
    })
    const queueTrigger = view.getByRole('button', {name: '打开原播放队列', exact: true})
    const beforeQueueScroll = await table.evaluate(element => element.scrollTop)
    await queueTrigger.focus(); await queueTrigger.press('Enter')
    await expect(page.locator('.inspector-close')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(queueTrigger).toBeFocused()
    expect(await table.evaluate(element => element.scrollTop)).toBe(beforeQueueScroll)
    const detailButton = view.getByRole('button', {name: '查看 009 UI Live 的版本与文件详情', exact: true})
    await detailButton.click()
    const detail = view.locator('.local-track-detail')
    await expect(detail.getByRole('heading', {name: '009 UI Live', exact: true})).toBeVisible()
    await expect(detail).toContainText('扫描解析报告')
    await expect(detail).toContainText('44.1 kHz')
    await expect(view).toContainText('尚未选择可用的 Roon 播放目标')
    await detail.getByRole('button', {name: '原文件直送', exact: true}).click()
    await expect(view.getByRole('alert')).toContainText('Roon Zone')
    await detail.getByLabel('仅修改 MB 显示名称', {exact: true}).fill('009 UI Live 显示更正')
    await detail.getByRole('button', {name: '保存显示更正', exact: true}).click()
    await expect(detail.getByRole('heading', {name: '009 UI Live 显示更正', exact: true})).toBeVisible()
    await expect(detail.getByRole('table')).toContainText('009 UI Live')
    await detail.getByRole('heading', {name: '009 UI Live 显示更正', exact: true}).press('Escape')
    await expect(detail).toHaveCount(0)
    await page.locator('[data-sidebar-source="home"]').click()
    await page.locator('[data-sidebar-source="local-library"]').click()
    await expect(input).toHaveValue('009 UI Live')
    await expect(view.locator('.local-results-summary')).toContainText('1 首')
    await expect(view.getByRole('button', {name: '查看 009 UI Live 显示更正 的版本与文件详情', exact: true})).toBeVisible()
    const after: Record<string, string> = {}
    for (const name of names) { after[name] = sha256(await readFile(path.join(source, name))); expect(after[name]).toBe(before[name]) }
    const network = await app.evaluate(() => (globalThis as typeof globalThis & {
      __musicBridgeUiE2eNetworkEvidence?: {installedBeforeWindow: boolean; blockedExternalAttempts: number}
    }).__musicBridgeUiE2eNetworkEvidence)
    expect(network?.installedBeforeWindow).toBe(true)
    expect(network?.blockedExternalAttempts).toBe(0)
    expect(pageErrors).toEqual([])
    await page.screenshot({path: test.info().outputPath('009-controlled-product-ui.png')})
    await writeFile(path.join(run, 'source-byte-preservation.json'), JSON.stringify({synthetic: true, source,
      before, after, sourceFilesUnchanged: true, dimensions, queueKeyboardFocusRestored: true, realRoonAudioOwner: 'NOT_RUN',
      layer: 'AUTOMATED_CONTROLLED_PRODUCT_UI_NOT_ROOT_CUA_OR_OWNER'}, null, 2) + '\n', {flag: 'wx', mode: 0o600})
  } finally {await app.close()}
})
