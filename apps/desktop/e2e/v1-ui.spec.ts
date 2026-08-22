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
const syntheticScreenshotPath = process.env.MUSIC_BRIDGE_SCREENSHOT_PATH ?? path.join(os.tmpdir(), 'musicbridge-task-033-home.png')

function navButton(name: string) {
  const index = ['Home', 'Search', 'Library', 'Now Playing', 'Queue', 'Settings', 'Diagnostics'].indexOf(name)
  if (index < 0) throw new Error(`未知导航项：${name}`)
  return page.locator('button.nav-item').nth(index)
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
  delete environment.NETEASE_COOKIE
  electronApp = await electron.launch({
    args: [electronEntry],
    cwd: desktopRoot,
    env: environment,
  })
  page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page).toHaveURL('musicbridge://app/index.html')
  await expect(page.getByRole('heading', { name: 'Home', exact: true }).first()).toBeVisible()
})

test.afterEach(async () => {
  await electronApp.close()
  await rm(diagnosticDirectory, { recursive: true, force: true })
})

test('packaged cold start, login states, navigation, focus and Renderer isolation', async () => {
  await expect(page.getByText(/Bridge Core 状态 ready/)).toBeVisible()
  await expect(page.getByText(/Roon 状态 ready/)).toBeVisible()
  await expect(page.locator('[data-ui-reference="simple-music-player-2"]')).toBeVisible()
  await expect(page.locator('.home-hero')).toBeVisible()
  await expect(page.locator('.global-player')).toBeVisible()
  await expect(page.locator('.player-progress')).toBeVisible()
  await page.screenshot({ path: syntheticScreenshotPath })
  expect((await stat(syntheticScreenshotPath)).size).toBeGreaterThan(20_000)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: '显示二维码' }).click()
  await expect(page.getByText('当前状态：waiting')).toBeVisible()
  await page.getByRole('button', { name: '取消' }).click()
  await expect(page.getByText('当前状态：cancelled')).toBeVisible()

  for (const name of ['Search', 'Library', 'Now Playing', 'Queue', 'Diagnostics']) {
    await navButton(name).click()
    await expect(page.getByRole('heading', { name, exact: true }).first()).toBeVisible()
  }

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

  await navButton('Search').focus()
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON')
  expect(await page.evaluate(() => ({ process: typeof (globalThis as { process?: unknown }).process, require: typeof (globalThis as { require?: unknown }).require }))).toEqual({ process: 'undefined', require: 'undefined' })
  expect(await page.evaluate(() => window.open('https://example.invalid'))).toBeNull()

  const crashEnvironment = {
    ...process.env,
    MUSIC_BRIDGE_UI_E2E: '1',
    MUSIC_BRIDGE_STARTUP_TEST: '1',
    MUSIC_BRIDGE_CORE_TEST_MODE: '1',
    MUSIC_BRIDGE_CORE_CRASH_GATE: '1',
  }
  delete crashEnvironment.NETEASE_COOKIE
  const crashApp = await electron.launch({
    args: [electronEntry],
    cwd: desktopRoot,
    env: crashEnvironment,
  })
  try {
    const crashPage = await crashApp.firstWindow()
    await expect(crashPage).toHaveURL('musicbridge://app/index.html')
    const output = await waitForProcessMarker(crashApp.process(), 'CORE_CRASH_GATE_PASS')
    expect(output).toContain('CORE_CRASH_GATE_PASS')
  } finally {
    await crashApp.close().catch(() => undefined)
  }
})

test('search, library pagination, playlist detail, queue controls and lyrics states', async () => {
  await navButton('Search').click()
  const search = page.getByLabel('搜索歌曲、艺人或专辑')
  await search.fill('synthetic')
  await expect(page.getByText('Synthetic Track 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.getByText('Synthetic Track 21', { exact: true })).toBeVisible()

  await navButton('Library').click()
  await expect(page.getByText('Synthetic Track 1', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '我的歌单' }).click()
  await expect(page.getByRole('button', { name: /Synthetic Playlist/ })).toBeVisible()
  await page.getByRole('button', { name: /Synthetic Playlist/ }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic Playlist', exact: true }).first()).toBeVisible()
  await expect(page.getByText('下一页')).toBeVisible()

  await navButton('Search').click()
  await search.fill('synthetic')
  await expect(page.getByText('Synthetic Track 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '播放 Synthetic Track 1', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Now Playing', exact: true }).first()).toBeVisible()
  await expect(page.getByText('暂无可用歌词。')).toBeVisible()
  await navButton('Queue').click()
  await expect(page.getByText('1 items')).toBeVisible()
  await navButton('Now Playing').click()
  await navButton('Search').click()
  await page.getByRole('button', { name: '播放 Synthetic Track 2', exact: true }).click()
  await expect(page.getByText('Synthetic lyric line', { exact: true }).first()).toBeVisible()

  await navButton('Settings').click()
  await page.locator('#quality-select').selectOption('hires')
  await navButton('Search').click()
  await page.getByRole('button', { name: '播放 Synthetic Track 1', exact: true }).click()
  await expect(page.getByText('实际质量', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Lossless', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/请求质量已被安全降级/)).toBeVisible()

  await navButton('Search').click()
  await expect(page.getByText('Synthetic Track 2', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '添加 Synthetic Track 2 到队列', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Next', exact: true }).last()).toBeEnabled()
  await page.getByRole('button', { name: 'Next', exact: true }).last().click()
  await expect(page.getByText('Synthetic Track 2', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Previous', exact: true }).last().click()
  await expect(page.getByText('Synthetic Track 1', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).last().click()
  await expect(page.getByText('待机')).toBeVisible()
})

test('关闭窗口只隐藏，激活恢复同一窗口并保留播放状态', async () => {
  await navButton('Search').click()
  const search = page.getByLabel('搜索歌曲、艺人或专辑')
  await search.fill('synthetic')
  await expect(page.getByText('Synthetic Track 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '播放 Synthetic Track 1', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Now Playing', exact: true }).first()).toBeVisible()
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
  await expect(page.getByRole('heading', { name: 'Now Playing', exact: true }).first()).toBeVisible()

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:command', 'show-queue')
  })
  await expect(page.getByRole('heading', { name: 'Queue', exact: true }).first()).toBeVisible()
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
