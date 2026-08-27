import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const electronEntry = path.join(desktopRoot, 'dist/main/index.js')
const require = createRequire(import.meta.url)
const axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8')

let electronApp: ElectronApplication
let page: Page
let diagnosticDirectory: string
let diagnosticPath: string
const syntheticScreenshotPath = process.env.MUSIC_BRIDGE_SCREENSHOT_PATH ?? path.join(os.tmpdir(), 'musicbridge-task-034-home.png')
const syntheticSettingsScreenshotPath = path.join(os.tmpdir(), 'musicbridge-task-034-settings.png')
const syntheticDailyScreenshotPath = path.join(os.tmpdir(), 'musicbridge-task-034-daily.png')
const syntheticSearchScreenshotPath = process.env.MUSIC_BRIDGE_SEARCH_SCREENSHOT_PATH ?? path.join(os.tmpdir(), 'musicbridge-v1-search.png')
const syntheticNowPlayingScreenshotPath = path.join(os.tmpdir(), 'musicbridge-task-037-now-playing.png')
const syntheticLyricsScreenshotPath = path.join(os.tmpdir(), 'musicbridge-task-037-lyrics-focus.png')
const syntheticControlsScreenshotPath = path.join(os.tmpdir(), 'musicbridge-task-037-controls.png')
const syntheticCoverUrl = 'https://p1.music.126.net/synthetic-cover.jpg'
const syntheticAvatarUrl = 'https://p1.music.126.net/synthetic-avatar.jpg'
const syntheticCoverSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800">
    <defs>
      <linearGradient id="cover" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#6b7cff"/>
        <stop offset="0.48" stop-color="#d568b7"/>
        <stop offset="1" stop-color="#f3a85f"/>
      </linearGradient>
      <filter id="soft"><feGaussianBlur stdDeviation="34"/></filter>
    </defs>
    <rect width="800" height="800" fill="#171b38"/>
    <circle cx="160" cy="180" r="230" fill="#7dd8ff" opacity=".85" filter="url(#soft)"/>
    <circle cx="620" cy="210" r="250" fill="#ff8cbd" opacity=".76" filter="url(#soft)"/>
    <circle cx="450" cy="680" r="290" fill="#ffbd73" opacity=".78" filter="url(#soft)"/>
    <rect x="88" y="88" width="624" height="624" rx="48" fill="url(#cover)" opacity=".62"/>
    <circle cx="400" cy="400" r="175" fill="none" stroke="#ffffff" stroke-opacity=".7" stroke-width="3"/>
    <circle cx="400" cy="400" r="28" fill="#ffffff" fill-opacity=".9"/>
  </svg>
`

function sourceButton(source: 'home' | 'liked' | 'playlists') {
  return page.locator(`[data-sidebar-source="${source}"]`)
}

function sidebarSearch() {
  return page.getByRole('searchbox', { name: '搜索歌曲或歌手' })
}

function connectionButton() {
  return page.getByRole('button', { name: '查看连接状态' })
}

async function openConnectionPopover() {
  const statusPopover = page.getByRole('dialog', { name: '连接状态' })
  if (!(await statusPopover.isVisible())) await connectionButton().click()
  await expect(statusPopover).toBeVisible()
  return statusPopover
}

async function openAccountSettings() {
  await page.getByRole('button', { name: '打开网易云账户设置' }).click()
  await expect(page.getByRole('heading', { name: '设置', exact: true }).first()).toBeVisible()
  const accountTab = page.getByRole('tab', { name: '账户', exact: true })
  if (await accountTab.isVisible()) await accountTab.click()
}

async function openDiagnostics() {
  const statusPopover = await openConnectionPopover()
  await statusPopover.getByRole('button', { name: '打开诊断' }).click()
  await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true }).first()).toBeVisible()
}

interface ZoneFixture {
  zoneId: string
  displayName: string
  selected: boolean
}

async function replaceZoneList(zones: readonly ZoneFixture[], delayMs = 0) {
  await electronApp.evaluate(({ ipcMain }, input) => {
    ipcMain.removeHandler('roon:list-zones')
    ipcMain.handle('roon:list-zones', async () => {
      if (input.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, input.delayMs))
      return { zones: input.zones }
    })
  }, { zones, delayMs })
}

async function installSyntheticLocalLyricsMatch() {
  await electronApp.evaluate(({ ipcMain }) => {
    let state: {
      status: 'needs-choice' | 'matched' | 'no-match'
      matchSessionId?: string
      candidates: Array<{ candidateId: string; title: string; artists: string[]; album: string; durationMs: number }>
      canRevoke: boolean
    } = {
      status: 'needs-choice',
      matchSessionId: 'session-0123456789abcdef',
      candidates: [
        { candidateId: 'candidate-0123456789abcdef', title: 'Synthetic Track 2', artists: ['Synthetic Artist'], album: 'Synthetic Album', durationMs: 210_000 },
        { candidateId: 'candidate-fedcba9876543210', title: 'Synthetic Track 2', artists: ['Synthetic Artist'], album: 'Synthetic Collection', durationMs: 212_000 },
      ],
      canRevoke: false,
    }
    for (const channel of ['lyrics:match:get', 'lyrics:match:select', 'lyrics:match:revoke']) ipcMain.removeHandler(channel)
    ipcMain.handle('lyrics:match:get', async () => state)
    ipcMain.handle('lyrics:match:select', async (_event, sessionId: unknown, candidateId: unknown) => {
      if (sessionId !== state.matchSessionId || !state.candidates.some((candidate) => candidate.candidateId === candidateId)) {
        throw new Error('Synthetic stale lyrics session')
      }
      state = { status: 'matched', candidates: [], canRevoke: true }
      return state
    })
    ipcMain.handle('lyrics:match:revoke', async () => {
      state = { status: 'no-match', candidates: [], canRevoke: false }
      return state
    })
  })
}

async function reloadWithZones(zones: readonly ZoneFixture[]) {
  await replaceZoneList(zones)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
}

function playerZoneButton() {
  return page.locator('.player-zone-button')
}

function playerQualityButton() {
  return page.getByRole('button', { name: '选择下次播放音质' })
}

async function openPlayerZonePopover() {
  const button = playerZoneButton()
  await expect(button).toBeVisible()
  await button.click()
  const popover = page.getByRole('dialog', { name: '播放设备' })
  await expect(popover).toBeVisible()
  return popover
}

async function emitCoreEvent(
  event: 'core.ready' | 'roon.changed',
  roon: 'disconnected' | 'paired' | 'ready',
) {
  await electronApp.evaluate(({ BrowserWindow }, input) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('core:event', {
      version: 1,
      event: input.event,
      payload: {
        state: {
          runtime: 'ready',
          roon: input.roon,
          provider: 'configured',
          activeStreamCount: 0,
          activePlaybackPresent: false,
        },
      },
    })
  }, { event, roon })
}

async function emitRemoteCoreEvent(status: 'ready' | 'stopping') {
  await electronApp.evaluate(({ BrowserWindow }, remoteStatus) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('remote-core:event', {
      mode: 'remote-core-development',
      status: remoteStatus,
      sshTarget: 'synthetic-core',
      localStreamPort: 38502,
      remoteStreamPort: 38512,
      remoteHealth: remoteStatus === 'ready' ? 'available' : 'unavailable',
      autoReconnect: true,
    })
  }, status)
}

async function resetZoneListCalls() {
  await electronApp.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { zoneListCalls?: number }
    runtime.zoneListCalls = 0
  })
}

async function readZoneListCalls() {
  return electronApp.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { zoneListCalls?: number }
    return runtime.zoneListCalls ?? 0
  })
}

async function waitForProcessMarker(
  child: ReturnType<ElectronApplication['process']>,
  marker: string,
): Promise<string> {
  const stdout = child.stdout
  if (!stdout) throw new Error('Electron crash gate 没有可读 stdout')
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`等待 Electron marker 超时：${marker}`))
    }, 10_000)
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString()
      if (!output.includes(marker)) return
      cleanup()
      resolve(output)
    }
    const onExit = () => {
      cleanup()
      reject(new Error(`Electron 在 marker 前退出：${marker}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      stdout.off('data', onData)
      child.off('exit', onExit)
    }
    stdout.on('data', onData)
    child.once('exit', onExit)
  })
}

test.beforeEach(async () => {
  diagnosticDirectory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-diagnostics-'))
  diagnosticPath = path.join(diagnosticDirectory, 'diagnostics.json')
  const environment = {
    ...process.env,
    MUSIC_BRIDGE_UI_E2E: '1',
    MUSIC_BRIDGE_CORE_TEST_MODE: '1',
    MUSIC_BRIDGE_DIAGNOSTIC_EXPORT_PATH: diagnosticPath,
  }
  if (test.info().title.includes('资料不可用')) {
    environment.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE = 'profile-unavailable'
  } else if (test.info().title.includes('登录过期')) {
    environment.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE = 'expired'
  }
  delete environment.NETEASE_COOKIE
  electronApp = await electron.launch({
    args: [electronEntry],
    cwd: desktopRoot,
    env: environment,
  })
  page = await electronApp.firstWindow()
  await page.route(syntheticCoverUrl, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: syntheticCoverSvg })
  })
  await page.route(syntheticAvatarUrl, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: syntheticCoverSvg })
  })
  await page.waitForLoadState('domcontentloaded')
  await expect(page).toHaveURL('musicbridge://app/index.html')
  await page.evaluate(() => {
    localStorage.removeItem('music-bridge.sidebar-expanded')
    localStorage.removeItem('musicbridge.qualityPreference')
    localStorage.removeItem('musicbridge.remoteCore.autoStart')
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await expect(page).toHaveURL('musicbridge://app/index.html')
  await expect(page.locator('#home-heading')).toBeVisible()
})

test.afterEach(async () => {
  await electronApp.close()
  await rm(diagnosticDirectory, { recursive: true, force: true })
})

test('Core 后连接时自动刷新 Zone 列表', async () => {
  await reloadWithZones([])
  await expect(connectionButton()).toContainText('已连接')
  await emitCoreEvent('roon.changed', 'disconnected')
  await expect(playerZoneButton()).toContainText('Core 已断开')
  const zonePopover = await openPlayerZonePopover()
  await expect(zonePopover.getByText('Core 已断开', { exact: true })).toBeVisible()

  await replaceZoneList([{ zoneId: 'delayed-zone', displayName: 'Delayed Zone', selected: false }])
  await emitCoreEvent('roon.changed', 'paired')

  await expect(zonePopover.getByRole('button', { name: 'Delayed Zone', exact: true })).toBeVisible()
})

test('Remote Core ready 时自动刷新 Zone 列表', async () => {
  await reloadWithZones([])
  await emitCoreEvent('core.ready', 'ready')
  const zonePopover = await openPlayerZonePopover()
  await expect(zonePopover.getByText('没有可用播放设备', { exact: true })).toBeVisible()

  await replaceZoneList([{ zoneId: 'remote-zone', displayName: 'Remote Zone', selected: false }])
  await emitRemoteCoreEvent('ready')

  await expect(zonePopover.getByRole('button', { name: 'Remote Zone', exact: true })).toBeVisible()
})

test('Remote Core 停止时清空旧 Zone 并显示 Core 已断开', async () => {
  await reloadWithZones([
    { zoneId: 'remote-stale-zone', displayName: 'Remote Stale Zone', selected: true },
  ])

  const zoneButton = playerZoneButton()
  await expect(zoneButton).toContainText('Remote Stale Zone')
  await emitRemoteCoreEvent('stopping')

  await expect(zoneButton).toContainText('Core 已断开')
  const zonePopover = await openPlayerZonePopover()
  await expect(zonePopover.getByText('Core 已断开', { exact: true })).toBeVisible()
  await expect(zonePopover.getByText('Remote Stale Zone', { exact: true })).toHaveCount(0)
})

test('连续 Core 生命周期事件只触发一次 Zone 刷新', async () => {
  await electronApp.evaluate(({ ipcMain }) => {
    const runtime = globalThis as typeof globalThis & { zoneListCalls?: number }
    runtime.zoneListCalls = 0
    ipcMain.removeHandler('roon:list-zones')
    ipcMain.handle('roon:list-zones', () => {
      runtime.zoneListCalls = (runtime.zoneListCalls ?? 0) + 1
      return {
        zones: [{ zoneId: 'coalesced-zone', displayName: 'Coalesced Zone', selected: false }],
      }
    })
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await expect(playerZoneButton()).toBeVisible()
  await resetZoneListCalls()

  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const state = {
      runtime: 'ready',
      roon: 'paired',
      provider: 'configured',
      activeStreamCount: 0,
      activePlaybackPresent: false,
    }
    window?.webContents.send('core:event', { version: 1, event: 'core.ready', payload: { state } })
    window?.webContents.send('core:event', { version: 1, event: 'roon.changed', payload: { state } })
    window?.webContents.send('core:event', { version: 1, event: 'roon.changed', payload: { state } })
  })
  await page.waitForTimeout(200)

  expect(await readZoneListCalls()).toBe(1)
  const zonePopover = await openPlayerZonePopover()
  await expect(zonePopover.getByRole('button', {
    name: 'Coalesced Zone',
    exact: true,
  })).toBeVisible()
})

test('较旧的空 Zone 响应不会覆盖较新的设备列表', async () => {
  await reloadWithZones([])
  const zonePopover = await openPlayerZonePopover()
  await expect(zonePopover.getByText('没有可用播放设备', { exact: true })).toBeVisible()

  await electronApp.evaluate(({ ipcMain }) => {
    const runtime = globalThis as typeof globalThis & {
      zoneListCalls?: number
      releaseOlderZoneList?: () => void
      olderZoneListResolved?: boolean
    }
    runtime.zoneListCalls = 0
    runtime.olderZoneListResolved = false
    ipcMain.removeHandler('roon:list-zones')
    ipcMain.handle('roon:list-zones', async () => {
      runtime.zoneListCalls = (runtime.zoneListCalls ?? 0) + 1
      if (runtime.zoneListCalls === 1) {
        await new Promise<void>((resolve) => {
          runtime.releaseOlderZoneList = resolve
        })
        runtime.olderZoneListResolved = true
        return { zones: [] }
      }
      return {
        zones: [{ zoneId: 'latest-zone', displayName: 'Latest Zone', selected: false }],
      }
    })
  })

  await emitCoreEvent('core.ready', 'paired')
  await expect.poll(readZoneListCalls).toBe(1)
  await emitCoreEvent('roon.changed', 'ready')
  await expect.poll(readZoneListCalls).toBe(2)

  const latestZone = zonePopover.getByRole('button', { name: 'Latest Zone', exact: true })
  await expect(latestZone).toBeVisible()
  await electronApp.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { releaseOlderZoneList?: () => void }
    runtime.releaseOlderZoneList?.()
  })
  await expect.poll(() => electronApp.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { olderZoneListResolved?: boolean }
    return runtime.olderZoneListResolved ?? false
  })).toBe(true)
  await expect(latestZone).toBeVisible()
})

test('Roon 断连时立即清空陈旧 Zone 且不再读取设备', async () => {
  await electronApp.evaluate(({ ipcMain }) => {
    const runtime = globalThis as typeof globalThis & { zoneListCalls?: number }
    runtime.zoneListCalls = 0
    ipcMain.removeHandler('roon:list-zones')
    ipcMain.handle('roon:list-zones', () => {
      runtime.zoneListCalls = (runtime.zoneListCalls ?? 0) + 1
      return {
        zones: [{ zoneId: 'stale-zone', displayName: 'Stale Zone', selected: false }],
      }
    })
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  const zonePopover = await openPlayerZonePopover()
  await expect(zonePopover.getByRole('button', { name: 'Stale Zone', exact: true })).toBeVisible()
  await resetZoneListCalls()
  await emitCoreEvent('roon.changed', 'disconnected')
  await page.waitForTimeout(100)

  await expect(zonePopover.getByText('Core 已断开', { exact: true })).toBeVisible()
  await expect(zonePopover.getByText('Roon 未连接', { exact: true })).toBeVisible()
  expect(await readZoneListCalls()).toBe(0)
})

test('Core 已连接但 Zone 尚未返回时显示加载状态', async () => {
  await reloadWithZones([])
  const zonePopover = await openPlayerZonePopover()
  await expect(zonePopover.getByText('没有可用播放设备', { exact: true })).toBeVisible()

  await replaceZoneList(
    [{ zoneId: 'loading-zone', displayName: 'Loaded Zone', selected: false }],
    300,
  )
  await emitCoreEvent('roon.changed', 'paired')
  await page.waitForTimeout(100)

  await expect(zonePopover.getByText('正在读取播放设备', { exact: true })).toBeVisible()
  await expect(zonePopover.getByRole('button', { name: 'Loaded Zone', exact: true })).toBeVisible()
})

test('Settings 与 Bottom Player 共享 Core 断连的 Zone 状态', async () => {
  await replaceZoneList([])
  await emitCoreEvent('roon.changed', 'disconnected')

  const zoneButton = playerZoneButton()
  await expect(zoneButton).toContainText('Core 已断开')
  await zoneButton.click()
  await expect(page.getByRole('dialog', { name: '播放设备' }).getByText('Core 已断开', {
    exact: true,
  })).toBeVisible()
  await page.keyboard.press('Escape')

  await openAccountSettings()
  await page.getByRole('tab', { name: 'Roon', exact: true }).click()
  await expect(page.locator('.settings-pane:visible').getByRole('definition').filter({
    hasText: /^Core 已断开$/,
  })).toBeVisible()
})

test('Settings 可手动刷新已连接 Core 的 Zone 列表', async () => {
  await reloadWithZones([])
  await openAccountSettings()
  await page.getByRole('tab', { name: 'Roon', exact: true }).click()
  const roonPane = page.locator('.settings-pane:visible')
  await expect(roonPane.getByRole('definition').filter({ hasText: /^没有可用播放设备$/ })).toBeVisible()

  await replaceZoneList([{ zoneId: 'manual-zone', displayName: 'Manual Zone', selected: false }])
  await roonPane.getByRole('button', { name: '刷新播放设备', exact: true }).click()

  await expect(roonPane.getByLabel('播放设备', { exact: true }).getByRole('option', {
    name: 'Manual Zone',
    exact: true,
  })).toHaveCount(1)
  await expect(roonPane.getByRole('definition').filter({ hasText: /^尚未选择播放设备$/ })).toBeVisible()
})

test('v5 Home、账户 Footer、Settings、每日推荐和 Renderer isolation', async () => {
  expect(await electronApp.evaluate(({ app }) => app.getName())).toBe('Music Bridge for Roon')
  await expect(page.getByRole('navigation', { name: '音乐来源' })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看连接状态' })).toBeVisible()
  await expect(page.locator('[data-ui-reference="simple-music-player-2"]')).toBeVisible()
  await expect(page.getByRole('region', { name: '每日推荐' })).toBeVisible()
  await expect(page.locator('.daily-recommendation-tile')).toHaveCount(8)
  await expect.poll(() => page.locator('.daily-recommendation-art img').first().evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.locator('.sidebar-account-footer')).toBeVisible()
  await expect(page.getByRole('button', { name: '打开网易云账户设置' })).toContainText('Synthetic Listener')
  await expect(page.locator('.global-player')).toBeVisible()
  const themeTokens = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement)
    return {
      background: styles.getPropertyValue('--mb-bg-deep').trim(),
      accent: styles.getPropertyValue('--mb-accent').trim(),
    }
  })
  expect(themeTokens).toEqual({ background: '#0e1217', accent: '#64d2ff' })
  await expect(sourceButton('home')).toHaveAttribute('aria-current', 'page')
  await expect(sourceButton('liked')).toBeVisible()
  await expect(sourceButton('playlists')).toBeVisible()
  await expect(page.getByRole('navigation', { name: '音乐来源' }).getByRole('button', { name: /Synthetic Playlist/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Synthetic Zone|选择播放设备/ })).toBeVisible()
  await expect(playerQualityButton()).toContainText('自动')
  await expect(page.getByRole('button', { name: '播放当前歌曲' })).toBeVisible()
  await playerQualityButton().click()
  const qualityPopover = page.getByRole('dialog', { name: '下次播放音质' })
  await expect(qualityPopover).toBeVisible()
  await expect(qualityPopover.getByRole('listbox', { name: '可选音质' })).toBeVisible()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(playerQualityButton()).toContainText('Hi-Res')
  await openAccountSettings()
  await expect(page.getByRole('tab', { name: '账户', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '播放', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Roon', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '应用', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '高级', exact: true })).toBeVisible()
  for (const category of ['账户', '播放', 'Roon', '应用', '高级']) {
    await page.getByRole('tab', { name: category, exact: true }).click()
    await expect(page.locator('.settings-pane:visible')).toHaveCount(1)
    await page.screenshot({ path: path.join(os.tmpdir(), 'musicbridge-v1-settings-' + category + '.png') })
  }
  await page.getByRole('tab', { name: '播放', exact: true }).click()
  await expect(page.locator('#quality-select')).toHaveValue('hires')
  await page.locator('#quality-select').selectOption('standard')
  await expect(playerQualityButton()).toContainText('Standard')
  await sourceButton('home').click()
  for (const name of ['Home', 'Search', 'Library', 'Now Playing', 'Queue', 'Settings', 'Diagnostics']) {
    await expect(page.getByRole('navigation', { name: '音乐来源' }).getByRole('button', { name, exact: true })).toHaveCount(0)
  }
  await page.screenshot({ path: syntheticScreenshotPath })
  expect((await stat(syntheticScreenshotPath)).size).toBeGreaterThan(20_000)

  await page.getByRole('button', { name: '查看全部 →' }).first().click()
  await expect(page.getByRole('heading', { name: '每日推荐', exact: true }).last()).toBeVisible()
  await expect(page.getByRole('table', { name: '歌曲列表' })).toBeVisible()
  await expect.poll(() => page.locator('.track-art img').first().evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: '返回主页' })).toBeVisible()
  await page.getByRole('button', { name: '返回主页' }).click()
  await expect(page.locator('#home-heading')).toBeVisible()
  await page.screenshot({ path: syntheticDailyScreenshotPath })
  expect((await stat(syntheticDailyScreenshotPath)).size).toBeGreaterThan(20_000)

  await sourceButton('home').click()
  await page.getByRole('button', { name: '播放 Synthetic Track 1', exact: true }).first().click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await expect(page.locator('.now-playing-lyrics')).toBeVisible()
  await expect(page.getByRole('progressbar', { name: '播放进度' })).toBeVisible()
  await expect(page.locator('.now-playing-quality-next')).toHaveCount(0)
  const nowPlayingQualityButton = page.getByRole('button', { name: /当前实际音质/ })
  await expect(nowPlayingQualityButton).toBeVisible()
  await expect(nowPlayingQualityButton).toContainText('Standard')
  await nowPlayingQualityButton.click()
  await expect(page.locator('.now-playing-quality-menu')).toHaveCount(0)
  await expect(nowPlayingQualityButton).toContainText(/1,411 kbps|1411 kbps/)
  await expect(page.locator('.now-playing-progress')).toBeVisible()
  await expect(page.locator('.music-sidebar')).toHaveCount(0)
  await expect(page.locator('.topbar')).toHaveCount(0)
  await expect(page.locator('.global-player')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '退出全屏播放' })).toBeVisible()
  await page.screenshot({ path: syntheticNowPlayingScreenshotPath })
  const normalTransportBounds = await page.locator('.transport-controls').boundingBox()
  const normalViewportHeight = await page.evaluate(() => window.innerHeight)
  expect(normalTransportBounds).not.toBeNull()
  expect(normalTransportBounds!.y + normalTransportBounds!.height).toBeLessThanOrEqual(normalViewportHeight + 1)
  expect((await stat(syntheticNowPlayingScreenshotPath)).size).toBeGreaterThan(20_000)
  await page.getByRole('button', { name: '退出全屏播放' }).click()
  await expect(page.locator('.global-player')).toBeVisible()
  await page.getByRole('button', { name: '暂停', exact: true }).last().click()
  await page.getByRole('button', { name: '恢复播放', exact: true }).last().click()
  await expect(page.getByRole('button', { name: '暂停', exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: '打开正在播放' }).click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await page.getByRole('button', { name: '退出全屏播放' }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).last().click()
  await sourceButton('home').click()
  await page.getByRole('button', { name: '播放全部', exact: true }).first().click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await page.getByRole('button', { name: '退出全屏播放' }).click()
  await page.getByRole('button', { name: '打开播放队列' }).click()
  await expect(page.getByText('12 首').last()).toBeVisible()
  await page.getByRole('button', { name: '打开正在播放' }).click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await page.getByRole('button', { name: '退出全屏播放' }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).last().click()
  await sourceButton('home').click()

  for (const [width, expectedColumns] of [[720, 4], [1024, 5], [1280, 6], [1600, 7], [1920, 8]] as const) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.locator('.daily-recommendation-grid').evaluate((grid) => {
      const bounds = grid.getBoundingClientRect()
      return Array.from(grid.children).filter((child) => {
        const childBounds = child.getBoundingClientRect()
        return childBounds.width > 0 && childBounds.left >= bounds.left - 1 && childBounds.right <= bounds.right + 1
      }).length
    })).toBe(expectedColumns)
  }
  await page.setViewportSize({ width: 1440, height: 900 })

  for (const width of [1280, 1440, 1728, 2048]) {
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({ path: path.join(os.tmpdir(), `musicbridge-v1-home-${width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 900 })

  await openAccountSettings()
  await page.getByRole('tab', { name: '高级', exact: true }).click()
  await expect(page.locator('[data-remote-core-settings]')).toBeVisible()
  await expect(page.locator('[data-remote-core-settings]')).toContainText('开发启动时自动连接（默认关闭）')
  await expect(page.getByRole('button', { name: '启动远程 Core' })).toBeVisible()
  await page.getByRole('tab', { name: '账户', exact: true }).click()
  await expect(page.locator('.account-settings-hero')).toContainText('Synthetic Listener')
  await expect(page.getByText('公开资料只包含昵称和头像')).toBeVisible()
  await expect.poll(() => page.locator('.account-settings-avatar img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await page.screenshot({ path: syntheticSettingsScreenshotPath })
  expect((await stat(syntheticSettingsScreenshotPath)).size).toBeGreaterThan(20_000)
  await page.getByRole('button', { name: '刷新账户' }).click()
  await expect(page.getByText('已连接 · 公开资料只包含昵称和头像')).toBeVisible()

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('button', { name: '扫码登录' })).toBeVisible()
  await page.getByRole('button', { name: '扫码登录' }).click()
  await expect(page.getByText('请使用网易云音乐扫码确认')).toBeVisible()
  await expect
    .poll(
      () =>
        page.locator('img[alt="网易云登录二维码"]').evaluate((image) => {
          return (image as HTMLImageElement).naturalWidth
        }),
      { message: 'Provider 登录二维码必须是浏览器可解码的图片' },
    )
    .toBeGreaterThan(0)
  await page.getByRole('button', { name: '取消' }).click()
  await expect(page.getByRole('button', { name: '扫码登录' })).toBeVisible()
  await sourceButton('home').click()
  await expect(page.getByRole('region', { name: '每日推荐' })).toContainText('需要网易云登录')

  const statusPopover = await openConnectionPopover()
  await expect(statusPopover).toBeVisible()
  await expect(statusPopover.getByText('Roon', { exact: true })).toBeVisible()
  await expect(statusPopover.getByText('已连接', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  await sidebarSearch().focus()
  await page.keyboard.press('Meta+L')
  await expect(sidebarSearch()).toBeFocused()

  await openDiagnostics()
  await page.getByRole('button', { name: '导出诊断文件' }).click()
  await expect(page.getByText('诊断文件已导出，仅包含脱敏运行信息。')).toBeVisible()
  const report = JSON.parse(await readFile(diagnosticPath, 'utf8')) as {
    schemaVersion?: number
  }
  expect(report.schemaVersion).toBe(1)
  expect((await stat(diagnosticPath)).mode & 0o777).toBe(0o600)
  expect(await readFile(diagnosticPath, 'utf8')).not.toMatch(
    /NETEASE_COOKIE|MUSIC_U|__csrf|Cookie|Authorization|Bearer|https?:\/\/|[?&][A-Za-z0-9_-]+=/i,
  )

  expect(await page.evaluate(() => ({ process: typeof (globalThis as { process?: unknown }).process, require: typeof (globalThis as { require?: unknown }).require }))).toEqual({ process: 'undefined', require: 'undefined' })
  expect(await page.evaluate(() => window.open('https://example.invalid'))).toBeNull()

  const crashEnvironment = {
    ...process.env,
    MUSIC_BRIDGE_UI_E2E: '1',
    MUSIC_BRIDGE_STARTUP_TEST: '1',
    MUSIC_BRIDGE_CORE_TEST_MODE: '1',
    MUSIC_BRIDGE_CORE_CRASH_GATE: '1',
  }
  const crashUserDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'musicbridge-task036-startup-'),
  )
  crashEnvironment.MUSIC_BRIDGE_STARTUP_USER_DATA_DIR = crashUserDataDirectory
  delete crashEnvironment.NETEASE_COOKIE
  let crashApp: ElectronApplication | undefined
  try {
    crashApp = await electron.launch({
      args: [electronEntry],
      cwd: desktopRoot,
      env: crashEnvironment,
    })
    const output = await waitForProcessMarker(crashApp.process(), 'CORE_CRASH_GATE_PASS')
    expect(output).toContain('CORE_CRASH_GATE_PASS')
  } finally {
    await crashApp?.close().catch(() => undefined)
    await rm(crashUserDataDirectory, { recursive: true, force: true })
  }
})

test('合成 Profile 资料不可用但登录仍有效', async () => {
  await expect(page.getByRole('button', { name: '打开网易云账户设置' })).toContainText('账户信息不可用')
  await expect(page.getByRole('region', { name: '每日推荐' })).toContainText('每日推荐')
  await expect(page.locator('.daily-recommendation-tile')).toHaveCount(8)

  await openAccountSettings()
  await expect(page.getByText('资料暂不可用')).toBeVisible()
  await expect(page.getByText('登录仍然有效')).toBeVisible()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  await page.getByRole('button', { name: '刷新账户' }).click()
  await expect(page.getByText('资料暂不可用')).toBeVisible()
})

test('合成登录过期后清空账户与每日推荐', async () => {
  await expect(page.getByRole('button', { name: '打开网易云账户设置' })).toContainText('登录已过期')
  await expect(page.getByRole('region', { name: '每日推荐' })).toContainText('需要网易云登录')

  await openAccountSettings()
  await expect(page.locator('.settings-view').getByText('登录已过期')).toBeVisible()
  await expect(page.getByRole('button', { name: '重新扫码' })).toBeVisible()
  await page.getByRole('button', { name: '重新扫码' }).click()
  await expect(page.getByText('请使用网易云音乐扫码确认')).toBeVisible()
})

test('search, library pagination, playlist detail, queue controls and lyrics states', async () => {
  const search = sidebarSearch()
  await search.fill('synthetic')
  await expect(page.getByText('Synthetic Track 1', { exact: true })).toBeVisible()
  const searchView = page.locator('.view-search')
  await expect(searchView.getByRole('heading', { name: '艺人', exact: true })).toBeVisible()
  await expect(searchView.getByRole('heading', { name: '单曲', exact: true })).toBeVisible()
  await expect(searchView.getByRole('heading', { name: '专辑', exact: true })).toBeVisible()
  await expect(searchView.getByText('歌单', { exact: true })).toHaveCount(0)
  await searchView.locator('.search-artist-card').first().click()
  await expect(searchView.getByText('艺人详情', { exact: true })).toBeVisible()
  await expect(searchView.getByRole('table', { name: '歌曲列表' })).toBeVisible()
  await searchView.getByRole('button', { name: '返回搜索结果' }).click()
  await expect(searchView.getByRole('heading', { name: '艺人', exact: true })).toBeVisible()
  await searchView.locator('.search-album-card').first().click()
  await expect(searchView.getByText('专辑详情', { exact: true })).toBeVisible()
  await searchView.getByRole('button', { name: '返回搜索结果' }).click()
  for (const query of ['青花瓷', '周杰伦', '张学友']) {
    await search.fill(query)
    await expect(searchView.getByRole('heading', { name: '艺人', exact: true })).toBeVisible()
    await expect(searchView.getByRole('heading', { name: '专辑', exact: true })).toBeVisible()
  }
  await search.fill('无结果字符串')
  await expect(searchView.getByText('没有匹配的艺人', { exact: true })).toBeVisible()
  await expect(searchView.getByText('没有匹配的专辑', { exact: true })).toBeVisible()
  await search.fill('synthetic')
  await expect(page.getByText('Synthetic Track 1', { exact: true })).toBeVisible()
  await expect(page.locator('.search-track-results .track-art').first()).toBeVisible()
  await expect.poll(async () => searchView.locator('.search-result-section h3').allTextContents()).toEqual(['艺人', '专辑', '单曲'])
  await page.screenshot({ path: syntheticSearchScreenshotPath })
  expect((await stat(syntheticSearchScreenshotPath)).size).toBeGreaterThan(20_000)
  const searchTrack21 = page.getByText('Synthetic Track 21', { exact: true })
  // 滚动会触发分页观察器；等待结果，不与正在被加载状态替换的按钮抢点击。
  await page.locator('.content-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(searchTrack21).toBeVisible()

  await sourceButton('liked').click()
  await expect(page.getByText('Synthetic Track 1', { exact: true })).toBeVisible()
  await sourceButton('playlists').click()
  const playlistRow = page.getByRole('navigation', { name: '音乐来源' }).getByRole('button', { name: /Synthetic Playlist/ })
  await expect(playlistRow).toBeVisible()
  await playlistRow.click()
  await expect(page.getByRole('heading', { name: 'Synthetic Playlist', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '加载更多歌曲' })).toBeVisible()
  const playlistView = page.locator('.view-playlist')
  const playlistScrollTop = await page.locator('.content-scroll').evaluate((element) => {
    element.scrollTop = 240
    return element.scrollTop
  })
  await playlistView.getByRole('button', { name: '播放 Synthetic Track 1', exact: true }).click()
  await expect(page.locator('.now-playing-fullscreen')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Synthetic Playlist', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '打开正在播放' }).click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await page.getByRole('button', { name: '退出全屏播放' }).click()
  await expect.poll(() => page.locator('.content-scroll').evaluate((element) => element.scrollTop)).toBe(playlistScrollTop)

  await search.fill('synthetic')
  await expect(page.getByText('Synthetic Track 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '播放 Synthetic Track 1', exact: true }).click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await expect(page.locator('.album-ambient-cover')).toBeVisible()
  await expect(page.locator('.album-ambient-cover')).toHaveCSS('animation-name', 'none')
  await expect.poll(() => page.locator('.now-playing-art img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.locator('.now-playing-lyrics')).toContainText('暂无歌词')
  await expect(page.locator('.global-player')).toHaveCount(0)
  await page.getByRole('button', { name: '退出全屏播放' }).click()
  await expect(page.locator('.global-player')).toBeVisible()
  await page.getByRole('button', { name: '打开播放队列' }).click()
  await expect(page.locator('.playback-inspector').getByText('0 首', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭播放检查器' }).click()
  await page.getByRole('button', { name: '打开正在播放' }).click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await page.getByRole('button', { name: '退出全屏播放' }).click()
  await search.fill('synthetic')
  await page.getByRole('button', { name: '播放 Synthetic Track 2', exact: true }).click()
  await expect(page.getByText('Midnight finds us wide awake', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '退出全屏播放' }).click()

  await openAccountSettings()
  await page.getByRole('tab', { name: '播放', exact: true }).click()
  await page.locator('#quality-select').selectOption('hires')
  await search.fill('synthetic')
  await page.getByRole('button', { name: '播放 Synthetic Track 1', exact: true }).click()
  await expect(page.locator('.now-playing-quality-next')).toHaveCount(0)
  const actualQualityButton = page.getByRole('button', { name: /当前实际音质/ })
  await expect(actualQualityButton).toContainText('Lossless')
  await expect(actualQualityButton).not.toContainText('Hi-Res')
  await actualQualityButton.click()
  await expect(actualQualityButton).toContainText(/1,411 kbps|1411 kbps/)
  await page.waitForTimeout(1_500)
  await expect(actualQualityButton).toContainText(/1,411 kbps|1411 kbps/)
  await expect(page.getByText(/请求质量已被安全降级/)).toBeVisible()
  await page.getByRole('button', { name: '退出全屏播放' }).click()

  await search.fill('synthetic')
  await expect(page.getByText('Synthetic Track 2', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: '打开 Synthetic Track 2 的更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '加入队列' }).click()
  await expect(page.getByRole('status')).toContainText('已加入播放队列')
  await expect(page.locator('.now-playing-fullscreen')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '搜索结果', exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: '下一首', exact: true }).last()).toBeEnabled()
  await page.getByRole('button', { name: '下一首', exact: true }).last().click()
  await expect(page.getByText('Synthetic Track 2', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '上一首', exact: true }).last().click()
  await expect(page.getByText('Synthetic Track 1', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '暂停', exact: true }).last().click()
  await expect(page.getByRole('button', { name: '恢复播放', exact: true }).last()).toBeVisible()
  await expect(page.locator('.album-ambient-cover')).toHaveCount(0)
})

test('TASK-037 Now Playing geometry, real queue names and full collection loading', async () => {
  const search = sidebarSearch()
  await search.fill('synthetic')
  await expect(page.getByText('Synthetic Track 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '播放 Synthetic Track 1', exact: true }).click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()

  for (const viewport of [
    { width: 960, height: 640 },
    { width: 1440, height: 900 },
    { width: 2048, height: 1152 },
  ]) {
    await page.setViewportSize(viewport)
    const geometry = await page.evaluate(() => {
      const art = document.querySelector<HTMLElement>('.now-playing-art')?.getBoundingClientRect()
      const lyrics = document.querySelector<HTMLElement>('.now-playing-lyrics')?.getBoundingClientRect()
      const stage = document.querySelector<HTMLElement>('.now-playing-stage')?.getBoundingClientRect()
      if (!art || !lyrics || !stage) throw new Error('Now Playing geometry nodes are missing')
      const overlap = !(art.right <= lyrics.left || lyrics.right <= art.left || art.bottom <= lyrics.top || lyrics.bottom <= art.top)
      return {
        art: { width: art.width, height: art.height, left: art.left, right: art.right, top: art.top, bottom: art.bottom },
        lyrics: { width: lyrics.width, height: lyrics.height, left: lyrics.left, right: lyrics.right, top: lyrics.top, bottom: lyrics.bottom, rightInset: window.innerWidth - lyrics.right },
        stage: { left: stage.left, right: stage.right },
        overlap,
        horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
      }
    })
    expect(geometry.art.width).toBeGreaterThan(0)
    expect(geometry.art.height).toBeGreaterThan(0)
    expect(geometry.lyrics.width).toBeGreaterThan(0)
    expect(geometry.lyrics.bottom).toBeGreaterThan(0)
    expect(geometry.lyrics.top).toBeLessThan(viewport.height)
    expect(geometry.lyrics.rightInset).toBeGreaterThanOrEqual(11)
    expect(geometry.lyrics.rightInset).toBeLessThanOrEqual(13)
    expect(geometry.overlap).toBe(false)
    expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1)
    expect(geometry.stage.right).toBeLessThanOrEqual(viewport.width + 1)
    if (viewport.width >= 1440) {
      expect(geometry.art.width).toBeGreaterThanOrEqual(360)
      expect(geometry.art.width).toBeLessThanOrEqual(500)
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: '退出全屏播放' }).click()
  await page.getByRole('button', { name: '打开 Synthetic Track 2 的更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '加入队列' }).click()
  await expect(page.getByRole('status')).toContainText('已加入播放队列')
  await page.getByRole('button', { name: '打开播放队列' }).click()
  await expect(page.getByText('队列歌曲')).toHaveCount(0)
  await expect(page.getByText('Synthetic Track 2', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Synthetic Artist · Synthetic Album', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: '关闭播放检查器' }).click()

  await sourceButton('playlists').click()
  const playlistRow = page.getByRole('navigation', { name: '音乐来源' }).getByRole('button', { name: /Synthetic Playlist/ })
  await playlistRow.click()
  await expect(page.getByRole('heading', { name: 'Synthetic Playlist', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '播放全部', exact: true }).click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await page.getByRole('button', { name: '退出全屏播放' }).click()
  await page.getByRole('button', { name: '打开播放队列' }).click()
  await expect(page.getByText('119 首', { exact: true })).toBeVisible()
  await expect(page.getByText('Synthetic Track 120', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭播放检查器' }).click()

  await sourceButton('liked').click()
  await expect(page.getByRole('table', { name: '歌曲列表' }).getByText('Synthetic Track 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '加载更多歌曲' }).click()
  await expect(page.getByText('Synthetic Track 21', { exact: true })).toBeVisible()
  await expect(page.getByRole('table', { name: '歌曲列表' }).getByText('Synthetic Track 1', { exact: true })).toBeVisible()
})

test('Now Playing 歌词保留多行上下文并标记当前焦点', async () => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const search = sidebarSearch()
  await search.fill('synthetic')
  await expect(page.getByText('Synthetic Track 2', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '播放 Synthetic Track 2', exact: true }).click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()

  const lines = page.locator('.now-playing-lyrics-lines .lyrics-line')
  await expect(lines).toHaveCount(8)
  await expect(lines.nth(0)).toHaveAttribute('data-line-distance', '0')
  await expect(lines.nth(0)).toHaveClass(/active/)
  await expect(lines.nth(1)).toHaveAttribute('data-line-distance', '1')
  await expect(lines.nth(4)).toHaveAttribute('data-line-distance', '4')
  await expect(lines.nth(7)).toHaveAttribute('data-line-distance', '7')
  await expect.poll(() => page.locator('.now-playing-lyrics-lines').evaluate((element) => {
    const active = element.querySelector<HTMLElement>('.lyrics-line.active')
    if (!active) return Number.POSITIVE_INFINITY
    const host = element.getBoundingClientRect()
    const line = active.getBoundingClientRect()
    return Math.abs((line.top + line.height / 2) - (host.top + host.height / 2))
  })).toBeLessThanOrEqual(12)

  const lyricsGeometry = await page.locator('.now-playing-lyrics').evaluate((element) => {
    const stage = element.closest<HTMLElement>('.now-playing-stage')
    const line = element.querySelector<HTMLElement>('.lyrics-line.active')
    if (!stage || !line) throw new Error('Now Playing lyrics geometry nodes are missing')
    const lyricsBounds = element.getBoundingClientRect()
    const stageBounds = stage.getBoundingClientRect()
    const lineStyle = getComputedStyle(line)
    return {
      rightInset: window.innerWidth - lyricsBounds.right,
      widthRatio: lyricsBounds.width / stageBounds.width,
      activeFontSize: Number.parseFloat(lineStyle.fontSize),
      fontFamily: lineStyle.fontFamily,
      wordSpacing: Number.parseFloat(lineStyle.wordSpacing),
    }
  })
  expect(lyricsGeometry.rightInset).toBeGreaterThanOrEqual(11)
  expect(lyricsGeometry.rightInset).toBeLessThanOrEqual(13)
  expect(lyricsGeometry.widthRatio).toBeGreaterThan(0.62)
  expect(lyricsGeometry.activeFontSize).toBeGreaterThanOrEqual(50)
  expect(lyricsGeometry.fontFamily).toContain('SF Pro Rounded')
  expect(lyricsGeometry.wordSpacing).toBeGreaterThan(0)

  const controls = await page.locator('.transport-controls').boundingBox()
  expect(controls).not.toBeNull()
  expect(controls!.y + controls!.height).toBeLessThanOrEqual(901)
  await page.screenshot({ path: syntheticLyricsScreenshotPath })
  await page.locator('.transport-controls').screenshot({ path: syntheticControlsScreenshotPath })
  expect((await stat(syntheticLyricsScreenshotPath)).size).toBeGreaterThan(20_000)
  expect((await stat(syntheticControlsScreenshotPath)).size).toBeGreaterThan(1_000)
})

test('本地歌词候选抽屉支持来源提示、键盘焦点、窄窗口和不重启播放的手动选择', async () => {
  await installSyntheticLocalLyricsMatch()
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 720, height: 820 })
  await page.getByRole('button', { name: '播放 Synthetic Track 2', exact: true }).first().click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await expect(page.getByText('歌词来源：网易云', { exact: true })).toBeVisible()

  const trigger = page.getByRole('button', { name: '选择匹配歌词' })
  await trigger.click()
  const drawer = page.getByRole('dialog', { name: '候选歌曲' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('Synthetic Collection', { exact: false })).toBeVisible()
  await expect(drawer).not.toContainText(/score|confidence|evidence|algorithmVersion|signature|trackId/iu)
  await expect(drawer.getByRole('button', { name: '关闭歌词匹配' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(drawer.getByRole('button', { name: '关闭', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(drawer.getByRole('button', { name: '关闭歌词匹配' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await trigger.click()
  await expect.poll(() => drawer.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return Math.max(0, bounds.right - window.innerWidth)
  })).toBeLessThanOrEqual(1)
  await expect.poll(() => drawer.evaluate((element) =>
    Math.abs(element.getBoundingClientRect().bottom - window.innerHeight),
  )).toBeLessThanOrEqual(1)
  await page.evaluate((source) => window.eval(source), axeSource)
  const candidateViolations = await page.evaluate(async () =>
    (await (window as typeof window & { axe: { run: (root: Element) => Promise<{ violations: { id: string; impact: string | null }[] }> } }).axe.run(
      document.querySelector('.lyrics-match-drawer')!,
    )).violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious'))
  expect(candidateViolations).toEqual([])
  await page.screenshot({ path: path.join(os.tmpdir(), 'musicbridge-task-046-lyrics-candidates.png') })
  const playbackBefore = await page.getByRole('button', { name: '暂停', exact: true }).isVisible()
  await drawer.getByRole('button', { name: /选择 Synthetic Track 2，Synthetic Artist/ }).last().click()
  await expect(drawer.getByText('当前歌词已经匹配。')).toBeVisible()
  expect(playbackBefore).toBe(true)
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '取消匹配' })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '关闭歌词匹配' })).toBeFocused()

  const accessibility = await page.evaluate(async (source) => {
    window.eval(source)
    return (await (window as typeof window & { axe: { run: (root: Element) => Promise<{ violations: { impact: string | null }[] }> } }).axe.run(
      document.querySelector('.lyrics-match-drawer')!,
    )).violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
  }, axeSource)
  expect(accessibility).toEqual([])
  await drawer.getByRole('button', { name: '取消匹配' }).click()
  await expect(drawer.getByText('没有找到可用候选。')).toBeVisible()
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: '歌词匹配', exact: true }).click()
  await expect(drawer).toHaveCSS('animation-name', 'none')
})

test('手动匹配请求的旧响应不覆盖更新的 Core 匹配事件', async () => {
  await installSyntheticLocalLyricsMatch()
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('lyrics:match:select')
    ipcMain.handle('lyrics:match:select', (event) => {
      event.sender.send('core:event', {
        version: 1,
        event: 'lyrics.match.changed',
        payload: { state: { status: 'no-match', candidates: [], canRevoke: false } },
      })
      return { status: 'matched', candidates: [], canRevoke: true }
    })
  })
  await page.reload()
  await page.getByRole('button', { name: '播放 Synthetic Track 2', exact: true }).first().click()
  await page.getByRole('button', { name: '选择匹配歌词' }).click()
  const drawer = page.getByRole('dialog', { name: '候选歌曲' })
  await drawer.getByRole('button', { name: /选择 Synthetic Track 2，Synthetic Artist/ }).first().click()
  await expect(drawer.getByText('没有找到可用候选。')).toBeVisible()
  await expect(drawer.getByText('当前歌词已经匹配。')).toHaveCount(0)
})

test('初始化匹配查询的延迟失败不清空已推送的新状态', async () => {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('lyrics:match:get')
    ipcMain.handle('lyrics:match:get', (event) => {
      event.sender.send('core:event', {
        version: 1,
        event: 'lyrics.match.changed',
        payload: { state: { status: 'no-match', candidates: [], canRevoke: false } },
      })
      throw new Error('Synthetic delayed initial request failure')
    })
  })
  await page.reload()
  await page.getByRole('button', { name: '播放 Synthetic Track 2', exact: true }).first().click()
  const trigger = page.getByRole('button', { name: '歌词匹配', exact: true })
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByRole('dialog', { name: '候选歌曲' }).getByText('没有找到可用候选。')).toBeVisible()
})

test('Music Source Sidebar supports source recovery, Zone Popover and collapsed rail', async () => {
  await page.keyboard.press('Meta+2')
  await expect(page.getByRole('heading', { name: '我喜欢的音乐', exact: true }).first()).toBeVisible()
  await page.keyboard.press('Meta+3')
  await expect(page.getByRole('heading', { name: '所有歌单', exact: true }).first()).toBeVisible()
  await page.keyboard.press('Meta+1')
  await expect(page.locator('#home-heading')).toBeVisible()

  await sourceButton('liked').click()
  await expect(page.getByRole('heading', { name: '我喜欢的音乐', exact: true }).first()).toBeVisible()

  const search = sidebarSearch()
  await search.fill('synthetic')
  await expect(page.getByRole('heading', { name: '搜索结果', exact: true }).first()).toBeVisible()
  await search.press('Escape')
  await expect(page.getByRole('heading', { name: '我喜欢的音乐', exact: true }).first()).toBeVisible()
  await expect(sourceButton('liked')).toHaveAttribute('aria-current', 'page')

  const zoneButton = page.getByRole('button', { name: /Synthetic Zone|选择播放设备/ }).first()
  await zoneButton.click()
  const zonePopover = page.getByRole('dialog', { name: '播放设备' })
  await expect(zonePopover).toBeVisible()
  await expect(zonePopover.getByText('Roon 已连接', { exact: true })).toBeVisible()
  await zonePopover.getByRole('button', { name: 'Synthetic Zone', exact: true }).click()
  await expect(zonePopover).toHaveCount(0)

  await page.getByRole('button', { name: '收起侧栏' }).click()
  await expect(page.locator('.music-sidebar')).toHaveClass(/is-collapsed/)
  await expect(page.getByRole('button', { name: '搜索音乐 (⌘L)' })).toBeVisible()
  await page.getByRole('button', { name: '歌单', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '歌单' }).getByText('Synthetic Playlist', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '歌单', exact: true }).click()
  await page.keyboard.press('Meta+Shift+L')
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await page.getByRole('button', { name: '退出全屏播放' }).click()
  await page.keyboard.press('Meta+Shift+Q')
  await expect(page.locator('.playback-inspector').getByRole('heading', { name: '播放队列', exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.playback-inspector')).toHaveCount(0)
  const queueTrigger = page.getByRole('button', { name: '打开播放队列' }).first()
  await queueTrigger.focus()
  await queueTrigger.press('Enter')
  await expect(page.locator('.playback-inspector').getByRole('heading', { name: '播放队列', exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.playback-inspector')).toHaveCount(0)
  await expect(queueTrigger).toBeFocused()
  await page.setViewportSize({ width: 720, height: 900 })
  await expect(page.locator('.music-sidebar')).toHaveCSS('flex-basis', '64px')
  await page.screenshot({ path: path.join(os.tmpdir(), 'musicbridge-task-033-sidebar-720.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: '展开侧栏' }).click()
  await expect(page.locator('.music-sidebar')).not.toHaveClass(/is-collapsed/)
})

test('关闭窗口只隐藏，激活恢复同一窗口并保留播放状态', async () => {
  const search = sidebarSearch()
  await search.fill('synthetic')
  await expect(page.getByText('Synthetic Track 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '播放 Synthetic Track 1', exact: true }).click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('playing')

  const hidden = await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return false
    window.close()
    return !window.isVisible()
  })
  expect(hidden).toBe(true)
  expect((await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('playing')

  const visible = await electronApp.evaluate(({ app, BrowserWindow }) => {
    app.emit('activate')
    const window = BrowserWindow.getAllWindows()[0]
    return Boolean(window && window.isVisible())
  })
  expect(visible).toBe(true)
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:command', 'show-queue')
  })
  await expect(page.locator('.playback-inspector').getByRole('heading', { name: '播放队列', exact: true }).first()).toBeVisible()
  expect((await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('playing')
})

test('退出命令完成 Core 清理并结束 Electron 进程', async () => {
  const child = electronApp.process()
  const exited = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron 退出超时')), 10_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  await electronApp.evaluate(({ app }) => app.quit())
  const exitCode = await exited
  expect(exitCode).toBe(0)
})

test('V3 收藏与录音分开，收藏视图支持键盘、搜索返回和收起侧栏', async () => {
  const collection = page.locator('[data-sidebar-source="collection"]')
  const recording = page.locator('[data-sidebar-source="recording"]')
  await expect(collection).toBeVisible()
  await expect(recording).toBeVisible()
  await expect(page.locator('[data-sidebar-source="roon-favorites"]')).toHaveAccessibleName('Roon 收藏')
  await collection.click()
  await expect(collection).toHaveAttribute('aria-current', 'page')
  const tapes = page.getByRole('tab', { name: '空白磁带收藏', exact: true })
  const music = page.getByRole('tab', { name: '实体音乐库', exact: true })
  await expect(tapes).toHaveAttribute('aria-selected', 'true')
  await tapes.focus()
  await tapes.press('ArrowRight')
  await expect(music).toBeFocused()
  await expect(music).toHaveAttribute('aria-selected', 'true')
  await music.press('Home')
  await expect(tapes).toBeFocused()
  await tapes.press('End')
  await expect(music).toBeFocused()
  await expect(page.getByRole('tabpanel', { name: '实体音乐库' })).toBeVisible()

  await recording.click()
  await expect(page.locator('[data-component="RecordingView"]')).toBeVisible()
  await expect(page.locator('[data-component="CollectionView"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '从 Roon 选择音乐', exact: true })).toBeDisabled()
  await expect(page.getByText('选曲与录音引擎尚未接入，当前不会操作播放设备。', { exact: true })).toBeVisible()
  await collection.click()
  await expect(music).toHaveAttribute('aria-selected', 'true')
  await sidebarSearch().fill('synthetic')
  await expect(page.locator('.view-search')).toBeVisible()
  await sidebarSearch().press('Escape')
  await expect(page.getByRole('tabpanel', { name: '实体音乐库' })).toBeVisible()

  await page.getByRole('button', { name: '收起侧栏' }).click()
  await recording.focus()
  await recording.press('Enter')
  await expect(recording).toHaveAttribute('aria-current', 'page')
  await expect(recording).toHaveAttribute('title', '录音')
  await expect(page.locator('.music-sidebar')).toHaveCount(1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(概览|设备|Overview|Equipment)$/ })).toHaveCount(0)
  await page.getByRole('button', { name: '查看空白磁带收藏', exact: true }).click()
  await expect(tapes).toHaveAttribute('aria-selected', 'true')
  await expect(collection).toHaveAttribute('aria-current', 'page')
})

test('V3 导航不触发播放变更 IPC，保留正在播放的曲目、队列和 Zone', async () => {
  await sidebarSearch().fill('synthetic')
  await page.getByRole('button', { name: '播放 Synthetic Track 1', exact: true }).click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('playing')
  await page.getByRole('button', { name: '退出全屏播放' }).click()
  const before = await page.evaluate(() => window.musicBridge.getPlaybackState())
  await electronApp.evaluate(({ ipcMain }) => {
    const runtime = globalThis as typeof globalThis & { v3PlaybackMutations?: string[] }
    runtime.v3PlaybackMutations = []
    // 只在本例的隔离 Electron 实例中拦截变更请求；任何尝试都将使末尾断言失败。
    for (const channel of [
      'playback:play', 'playback:pause', 'playback:resume', 'playback:stop',
      'playback:next', 'playback:previous', 'playback:play-queue-index',
      'playback:replace-queue', 'playback:append-queue', 'playback:insert-next',
      'playback:seek', 'roon:select-zone', 'roon:library:play',
    ]) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => { runtime.v3PlaybackMutations?.push(channel); return undefined })
    }
  })
  await page.locator('[data-sidebar-source="collection"]').click()
  await page.getByRole('tab', { name: '实体音乐库', exact: true }).click()
  await page.locator('[data-sidebar-source="recording"]').click()
  await expect(page.locator('[data-component="RecordingView"]')).toBeVisible()
  await expect(page.locator('.global-player')).toBeVisible()
  await page.getByRole('button', { name: '查看空白磁带收藏', exact: true }).click()
  await sourceButton('home').click()
  await expect(page.locator('#home-heading')).toBeVisible()
  const after = await page.evaluate(() => window.musicBridge.getPlaybackState())
  expect(after.state).toBe('playing')
  expect(after.currentTrack?.id).toBe(before.currentTrack?.id)
  expect(after.queue).toEqual(before.queue)
  expect(after.selectedZoneId).toBe(before.selectedZoneId)
  expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { v3PlaybackMutations?: string[] }).v3PlaybackMutations)).toEqual([])
})

test('V3 页面在桌面和最小窗口无横向溢出，未接入状态与无障碍检查清晰', async () => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const size of [{ width: 1440, height: 900 }, { width: 720, height: 480 }]) {
    await page.setViewportSize(size)
    for (const view of ['collection', 'recording']) {
      await page.locator(`[data-sidebar-source="${view}"]`).click()
      if (view === 'collection') {
        await expect(page.getByRole('tabpanel', { name: '空白磁带收藏' }).getByText('库存录入与照片管理尚未接入，当前不展示示例库存。', { exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: '添加磁带', exact: true })).toBeDisabled()
      }
      expect(await page.locator('.content-scroll').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      await page.evaluate((source) => window.eval(source), axeSource)
      // 新页面单独验收；整页 V2 检查仍由下方既有测试执行。闲置播放器的已复现对比度问题另记 carryover。
      const violations = await page.evaluate(async (activeView) => {
        const root = document.querySelector(`[data-component="${activeView === 'collection' ? 'CollectionView' : 'RecordingView'}"]`)
        if (!root) throw new Error('V3 页面未挂载')
        const result = await (window as typeof window & { axe: { run: (root: Element) => Promise<{ violations: { id: string; impact: string | null }[] }> } }).axe.run(root)
        return result.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious')
      }, view)
      expect(violations).toEqual([])
      await page.screenshot({ path: path.join(os.tmpdir(), `musicbridge-task-048-${view}-${size.width}.png`) })
    }
  }
  expect(errors).toEqual([])
})

test('packaged UI has no critical or serious axe findings', async () => {
  const results = await electronApp.evaluate(async ({ BrowserWindow }, source) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('没有找到 Electron 窗口')
    return window.webContents.executeJavaScript(
      `${source}\n; axe.run(document)`,
      true,
    )
  }, axeSource)
  expect(results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')).toEqual([])
})
