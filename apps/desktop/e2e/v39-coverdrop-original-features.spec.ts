import { _electron as electron, expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { verifiedElectronExecution } from '../scripts/electron-identity.mjs'
import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { e2eTemporaryRoot } from './temporary-root.js'
import { waitForMainWindow } from './main-window.js'

/** 独立合成PCM，原图/歌词/文件及真实账号不进入这个自动化窗口。 */
function wave(): Buffer {
  const format = Buffer.alloc(24); format.write('fmt '); format.writeUInt32LE(16, 4); format.writeUInt16LE(1, 8); format.writeUInt16LE(2, 10); format.writeUInt32LE(44100, 12); format.writeUInt32LE(176400, 16); format.writeUInt16LE(4, 20); format.writeUInt16LE(16, 22)
  const data = Buffer.alloc(8 + 44100 * 4); data.write('data'); data.writeUInt32LE(data.length - 8, 4)
  for (let at = 8; at < data.length; at += 4) { data.writeInt16LE(123 + at % 127, at); data.writeInt16LE(-123 - at % 127, at + 2) }
  const body = Buffer.concat([Buffer.from('WAVE'), format, data]), header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4); return Buffer.concat([header, body])
}
const hash = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex')
test('002正式离线Main/Preload/Owner专辑墙与独立CoverDrop共享同工作台，保留全部筛选和原维护', async () => {
  test.setTimeout(120000)
  const run = await mkdtemp(path.join(e2eTemporaryRoot(), 'v39-coverdrop-ui-'))
  const profile = await mkdtemp(path.join(e2eTemporaryRoot(), 'musicbridge-ui-e2e-v39-coverdrop-'))
  const source = path.join(run, '合成专辑库'); await mkdir(source)
  const audio = path.join(source, '合成曲目.wav'), raw = wave(); await writeFile(audio, raw, { flag: 'wx', mode: 0o600 })
  // 第二个自有目录由真实扫描分组七张专辑；不更改原单专辑输入。
  const layoutSource = path.join(run, '合成七专辑库'); await mkdir(layoutSource)
  const layoutAssets: { file: string; sha256: string }[] = []
  const coverPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQqNjyHwAEdAJUVL0nqQAAAABJRU5ErkJggg==', 'base64')
  for (let album = 1; album <= 7; album++) {
    const directory = path.join(layoutSource, `专辑${String(album).padStart(2, '0')}`); await mkdir(directory)
    const file = path.join(directory, '合成曲目.wav'); await writeFile(file, raw, { flag: 'wx', mode: 0o600 }); layoutAssets.push({ file, sha256: hash(raw) })
    if (album % 2 === 0) {
      const cover = path.join(directory, 'cover.png'); await writeFile(cover, coverPng, { flag: 'wx', mode: 0o600 }); layoutAssets.push({ file: cover, sha256: hash(coverPng) })
    }
  }
  const identity = verifiedElectronExecution(), desktop = path.resolve(import.meta.dirname, '..')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  Object.assign(env, { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_TEST_KEYCHAIN_MODE: 'mock', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profile })
  const app = await electron.launch({ executablePath: path.join(identity.packageRoot, 'dist', 'Electron.app/Contents/MacOS/Electron'), args: testElectronArguments([path.join(desktop, 'dist/main/index.js')], 'mock'), cwd: desktop, env })
  try {
    const page = await waitForMainWindow(app), errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    async function observeGrid544(label: 'default-local' | 'coverdrop-before-user-scroll' | 'coverdrop-after-user-scroll'): Promise<void> {
      // 私有被动附件；失败旁路，既不刷新或等待数据，也不加入业务准入判据。
      try {
        const observation = await page.evaluate(layer => {
          const section = document.querySelector<HTMLElement>(layer === 'default-local' ? '[data-testid="local-library-view"] [data-testid="local-album-browser"]' : '[data-testid="coverdrop-workspace"]')
          const grid = section?.querySelector<HTMLElement>(layer === 'default-local' ? '.local-album-grid' : '.coverdrop-wall .local-album-grid') ?? null
          const scroll = grid?.closest<HTMLElement>('.content-scroll') ?? section?.closest<HTMLElement>('.content-scroll') ?? null
          const card = grid?.querySelector<HTMLElement>('button[data-local-album-id]') ?? null
          const bounds = (element: HTMLElement | null) => { if (!element) return null; const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height } }
          const gridRect = bounds(grid), portRect = bounds(scroll), cardRect = bounds(card)
          const intersection = cardRect && portRect ? { width: Math.max(0, Math.min(cardRect.right, portRect.right, innerWidth) - Math.max(cardRect.left, portRect.left, 0)),
            height: Math.max(0, Math.min(cardRect.bottom, portRect.bottom, innerHeight) - Math.max(cardRect.top, portRect.top, 0)) } : null
          return { layer, observedAtEpochMs: Date.now(), performanceMs: performance.now(), viewport: { width: innerWidth, height: innerHeight },
            section: bounds(section), grid: gridRect, card: cardRect, cardId: card?.getAttribute('data-local-album-id') ?? null,
            port: scroll ? { bounds: portRect, scrollTop: scroll.scrollTop, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight } : null,
            gridAttributes: grid ? Object.fromEntries(Array.from(grid.attributes).filter(a => a.name.startsWith('data-grid-')).map(a => [a.name, a.value])) : null,
            actualCardCount: grid?.querySelectorAll('button[data-local-album-id]').length ?? null, intersection,
            userScrollPerformed: layer === 'coverdrop-after-user-scroll', sourceQualified: false, formalAcceptance: false }
        }, label)
        const file = test.info().outputPath(`grid-geometry-${label}544.json`)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' })
        await test.info().attach(`grid-geometry-${label}544`, { path: file, contentType: 'application/json' })
      } catch (error) { console.error(JSON.stringify({ event: 'private_grid_geometry_observation_failed544', label, name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) })) }
      try {
        const screenshot = test.info().outputPath(`grid-${label}544.png`)
        await page.screenshot({ path: screenshot })
        await test.info().attach(`grid-${label}544`, { path: screenshot, contentType: 'image/png' })
      } catch (error) { console.error(JSON.stringify({ event: 'private_grid_screenshot_failed544', label, name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) })) }
    }

    // 原系统选择结果仍为受控输入：只转发固定library prompt到自有Node子进程，不替换Main/Preload/Owner或目录许可。
    const ts = await import('typescript')
    const chooserSource = await readFile(path.join(desktop, 'src/main/local-library-workbench/native-chooser.ts'), 'utf8')
    const chooserAst = ts.createSourceFile('native-chooser.ts', chooserSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const promptDeclarations = chooserAst.statements.filter((node): node is import('typescript').FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'localWorkbenchNativePromptScript')
    expect(promptDeclarations).toHaveLength(1)
    const originalPrompt = promptDeclarations[0]!
    const privatePrompt = ts.factory.updateFunctionDeclaration(originalPrompt, originalPrompt.modifiers?.filter(item => item.kind !== ts.SyntaxKind.ExportKeyword), originalPrompt.asteriskToken, originalPrompt.name, originalPrompt.typeParameters, originalPrompt.parameters, originalPrompt.type, originalPrompt.body)
    const promptCode = ts.transpileModule(ts.createPrinter().printNode(ts.EmitHint.Unspecified, privatePrompt, chooserAst), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    const expectedPrompt = (new Function(`${promptCode}\nreturn localWorkbenchNativePromptScript;`)() as (mode: 'library') => string)('library')
    await app.evaluate(async (_electron, selected) => {
      // Electron Main evaluate独立realm没有动态import callback；只取同进程原Node内建对象。
      const childProcess = process.getBuiltinModule('node:child_process') as typeof import('node:child_process') | undefined
      const builtinModule = process.getBuiltinModule('node:module') as typeof import('node:module') | undefined
      if (!childProcess || typeof childProcess.spawn !== 'function' || !builtinModule || typeof builtinModule.syncBuiltinESMExports !== 'function') throw new Error('Main原Node内建选择模块尚未确认。')
      const { syncBuiltinESMExports } = builtinModule
      const originalSpawn = childProcess.spawn
      const rows: { pid: number | null; closed: boolean; code: number | null; signal: string | null; failed: boolean }[] = []
      const nodeCode = (root: string) => `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{input+=part;if(Buffer.byteLength(input)>65536)throw Error('受控picker输入超限');});process.stdin.on('end',()=>{if(input!==${JSON.stringify(selected.expectedPrompt)}){process.stderr.write('非原library prompt');process.exitCode=1;return;}process.stdout.write(JSON.stringify({cancelled:false,value:${JSON.stringify(root)}}));});`
      childProcess.spawn = ((file: string, args: readonly string[], options: import('node:child_process').SpawnOptionsWithoutStdio) => {
        if (file !== '/usr/bin/osascript') return originalSpawn(file, args, options)
        if (args.length !== 2 || args[0] !== '-l' || args[1] !== 'JavaScript') throw new Error('受控picker只接受原固定调用。')
        const chosenRoot = [selected.root, selected.layoutRoot][rows.length]
        if (!chosenRoot) throw new Error('受控picker没有另一原授权目录。')
        const child = originalSpawn(process.execPath, ['-e', nodeCode(chosenRoot)], { ...options, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' } })
        const row = { pid: child.pid ?? null, closed: false, code: null as number | null, signal: null as string | null, failed: false }; rows.push(row)
        child.once('error', () => { row.failed = true })
        child.once('close', (code, signal) => { row.closed = true; row.code = code; row.signal = signal })
        return child
      }) as typeof childProcess.spawn
      syncBuiltinESMExports()
      ;(globalThis as typeof globalThis & { __musicBridgeV39ControlledPicker?: { evidence(): typeof rows } }).__musicBridgeV39ControlledPicker = { evidence: () => rows.map(row => ({ ...row })) }
    }, { root: source, layoutRoot: layoutSource, expectedPrompt })
    await page.locator('[data-sidebar-source="local-library"]').click()
    const view = page.getByTestId('local-library-view')
    await view.getByRole('button', { name: '在 CoverDrop 管理目录与扫描', exact: true }).click()
    const coverDrop = page.getByTestId('coverdrop-workspace')
    await expect(coverDrop.getByRole('heading', { name: 'CoverDrop', exact: true })).toBeVisible()
    await expect(page.locator('[data-sidebar-source="coverdrop"]')).toHaveCount(1)
    const workspace = coverDrop.locator('section.local-library-workbench.is-page')
    await expect(workspace).toBeVisible()
    await workspace.getByRole('button', { name: '整个音乐库', exact: true }).click()
    await workspace.getByRole('button', { name: '打开音乐库与解析设置', exact: true }).click()
    const management = coverDrop.getByRole('region', { name: '音乐库与解析设置', exact: true })
    await expect(management).toBeVisible()
    await management.getByRole('button', { name: '选择文件夹并确认库结构', exact: true }).click()
    const role = management.getByRole('region', { name: '目录角色确认', exact: true })
    await expect(role.getByRole('heading', { name: '合成专辑库', exact: true })).toBeVisible()
    await role.getByRole('combobox', { name: '目录角色', exact: true }).selectOption('album')
    await role.getByRole('button', { name: '确认角色并导入', exact: true }).click()
    await expect(role).toBeHidden()
    const libraries = coverDrop.getByRole('group', { name: '持久音乐库选择', exact: true })
    await expect(libraries.locator('button.coverdrop-library')).toHaveCount(1)
    await expect(libraries).toContainText('合成专辑库'); await expect(libraries).toContainText('单张专辑')
    await libraries.locator('button.coverdrop-library').click()
    await expect(management.getByRole('button', { name: '增量扫描', exact: true })).toBeEnabled()
    await management.getByRole('button', { name: '增量扫描', exact: true }).click()
    await expect(management.getByRole('list', { name: '扫描任务' })).toContainText('已完成', { timeout: 45000 })
    await management.getByRole('button', { name: '返回音乐库', exact: true }).click()
    await expect(management).toBeHidden()
    await expect(workspace).toBeHidden()
    await page.locator('[data-sidebar-source="local-library"]').click()
    await view.getByRole('button', { name: '刷新', exact: true }).last().click()
    const browser = view.getByTestId('local-album-browser'); await expect(browser.locator('.local-album-result-summary')).toContainText('1 张专辑')
    const filters = browser.getByRole('group', { name: '本地专辑筛选', exact: true }); await expect(filters.getByRole('button')).toHaveCount(9)
    for (const label of ['全部专辑', '缺封面', '已有封面', '未分轨', '标签异常', '名称解析失败', '散落音频', 'track 音轨', '缺歌词']) await expect(filters).toContainText(label)
    await observeGrid544('default-local')
    const originalAlbum = browser.locator('button[data-local-album-id]'); await expect(originalAlbum).toHaveCount(1)
    const originalAlbumId = await originalAlbum.getAttribute('data-local-album-id'); expect(originalAlbumId).toBeTruthy()
    await page.locator('[data-sidebar-source="coverdrop"]').click(); await expect(coverDrop.getByRole('heading', { name: 'CoverDrop', exact: true })).toBeVisible()
    await expect(page.locator('[data-sidebar-source="coverdrop"]')).toHaveCount(1)
    await expect(libraries.locator('button.coverdrop-library')).toHaveCount(1)
    await expect(libraries).toContainText('合成专辑库')
    try { await expect(coverDrop.locator('.coverdrop-stat strong')).toHaveText('1') }
    catch (error) {
      // 仅在原断言拒绝后读取当前DOM；不请求、刷新、改变选择或回推原等待期间状态。
      try {
        const dom = await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>('[data-testid="coverdrop-workspace"]')
          const describe = (element: HTMLElement | null) => {
            if (!element) return null
            const style = getComputedStyle(element), bounds = element.getBoundingClientRect()
            const field = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element : null
            return { tag: element.tagName, text: element.textContent, aria: Object.fromEntries(Array.from(element.attributes).filter(attribute => attribute.name === 'role' || attribute.name.startsWith('aria-')).map(attribute => [attribute.name, attribute.value])),
              classes: element.className, hidden: element.hidden, visible: style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0,
              inputType: element instanceof HTMLInputElement ? element.type : null, value: field instanceof HTMLInputElement && field.type === 'password' ? null : field?.value ?? null,
              checked: element instanceof HTMLInputElement ? element.checked : null, disabled: element instanceof HTMLButtonElement ? element.disabled : field?.disabled ?? null,
              localAlbumId: element.getAttribute('data-local-album-id') }
          }
          const list = (selector: string) => root ? Array.from(root.querySelectorAll<HTMLElement>(selector)).map(describe) : []
          return { observedAtEpochMs: Date.now(), performanceMs: performance.now(), workspacePresent: root !== null, workspace: describe(root), activeElement: document.activeElement instanceof HTMLElement ? describe(document.activeElement) : null,
            header: list('.coverdrop-library-header h2, .coverdrop-library-header p'), stat: list('.coverdrop-stat strong'), libraries: list('.coverdrop-library-list button.coverdrop-library'),
            filters: list('.coverdrop-filter-tabs button'), search: list('.coverdrop-filter-bar input[type="search"]'), controls: list('button, input:not([type="password"]), select'),
            alerts: list('[role="alert"]'), status: list('[role="status"]'), empty: list('.coverdrop-no-library, .coverdrop-wall .empty-state'), cards: list('.coverdrop-wall button[data-local-album-id]'),
            originalLocalSummary: describe(document.querySelector<HTMLElement>('[data-testid="local-library-view"] .local-album-result-summary')) }
        })
        const body = Buffer.from(JSON.stringify({ schema: 'v39.coverdrop-first-count-failure592.v1', phase: 'AFTER_ORIGINAL_FIRST_COUNT_ASSERTION_REJECTED', expected: '1', originalAlbumId,
          originalAssertionError: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? null } : { name: 'Unknown', message: String(error), stack: null },
          pageErrors: [...errors], dom, sourceQualified: false, formalAcceptance: false }, null, 2))
        if (body.length > 16 * 1024 * 1024) throw new Error('本次被动DOM附件超过原16MiB界限。')
        await test.info().attach('coverdrop-first-count-failure592', { body, contentType: 'application/json' })
      } catch (observationError) { console.error(JSON.stringify({ event: 'private_coverdrop_count_observation_failed592', name: observationError instanceof Error ? observationError.name : 'Error', message: observationError instanceof Error ? observationError.message : String(observationError) })) }
      throw error
    }
    await observeGrid544('coverdrop-before-user-scroll')
    // 独立CoverDrop墙正常滚入当前视口，消费原合法虚拟窗口；不改items/count/算法。
    await coverDrop.locator('.coverdrop-wall .local-album-grid').scrollIntoViewIfNeeded()
    await observeGrid544('coverdrop-after-user-scroll')
    const sameAlbum = coverDrop.locator('.coverdrop-wall button[data-local-album-id]'); await expect(sameAlbum).toHaveCount(1)
    expect(await sameAlbum.getAttribute('data-local-album-id')).toBe(originalAlbumId)
    const coverDropFilters = coverDrop.getByRole('group', { name: 'CoverDrop 九种专辑筛选', exact: true }); await expect(coverDropFilters.getByRole('button')).toHaveCount(9)
    for (const label of ['全部', '缺封面', '缺少歌词', '未分轨', '标签异常', 'track音轨', '已有封面', '解析失败', '散落音频']) await expect(coverDropFilters.getByRole('button', { name: label, exact: true })).toBeVisible()
    await coverDrop.getByRole('button', { name: '批量获取歌词', exact: true }).click()
    await expect(workspace).toBeVisible()
    const originalTools = workspace.getByRole('navigation', { name: '原整理功能', exact: true }); await expect(originalTools.getByRole('button')).toHaveCount(7)
    for (const label of ['曲目', '封面', '歌词', '智能解析', 'CUE 分轨', '信息与文件整理', '整个音乐库']) await expect(originalTools.getByRole('button', { name: label, exact: true })).toBeVisible()
    await expect(workspace.getByRole('heading', { name: '整个音乐库的缺词', exact: true })).toBeVisible()
    // 标题先于捕获出现；只读库存回显确认本次完整库引用已经完成绑定。
    const captureLoading = coverDrop.getByRole('status').filter({ hasText: /^正在读取完整专辑范围…$/u })
    const lyricsBatch = workspace.getByRole('region', { name: '全库歌词批次', exact: true })
    const inventorySummary = lyricsBatch.getByText('1 张 · 离线或无法读取保留未知，不当作缺词。', { exact: true })
    await expect(captureLoading).toBeHidden()
    await expect(lyricsBatch.getByRole('button', { name: '获取并保存全库缺词', exact: true })).toBeEnabled()
    await lyricsBatch.getByRole('button', { name: '全部歌词状态', exact: true }).click()
    await expect(inventorySummary).toBeVisible()
    await workspace.getByRole('button', { name: '打开音乐库与解析设置', exact: true }).click()
    await expect(management.getByRole('button', { name: '选择文件夹并确认库结构', exact: true })).toBeVisible()
    const concurrency = management.getByRole('spinbutton', { name: '扫描并发（1–24）', exact: true })
    const originalConcurrency = Number(await concurrency.inputValue()), nextConcurrency = originalConcurrency === 24 ? 23 : originalConcurrency + 1
    await concurrency.fill(String(nextConcurrency))
    await management.getByRole('button', { name: '返回音乐库', exact: true }).click()
    await page.locator('[data-sidebar-source="home"]').click(); await expect(workspace.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible()
    await workspace.getByRole('button', { name: '继续编辑', exact: true }).click(); await expect(page.locator('[data-sidebar-source="coverdrop"]')).toHaveClass(/selected/u)
    await workspace.getByRole('button', { name: '打开音乐库与解析设置', exact: true }).click()
    expect(await concurrency.inputValue()).toBe(String(nextConcurrency))
    await management.getByRole('button', { name: '返回音乐库', exact: true }).click()
    await page.locator('[data-sidebar-source="home"]').click(); await workspace.getByRole('button', { name: '保存并离开', exact: true }).click(); await expect(workspace).toBeHidden()
    await page.locator('[data-sidebar-source="coverdrop"]').click(); await coverDrop.getByRole('button', { name: '批量获取歌词', exact: true }).click()
    await expect(workspace.getByRole('heading', { name: '整个音乐库的缺词', exact: true })).toBeVisible()
    // 关闭、保存与导航不会清除旧库存；新capture应用及绑定必须先使它失效。
    await expect(captureLoading).toBeHidden()
    await expect(inventorySummary).toHaveCount(0)
    await expect(lyricsBatch.getByRole('button', { name: '获取并保存全库缺词', exact: true })).toBeEnabled()
    await lyricsBatch.getByRole('button', { name: '全部歌词状态', exact: true }).click()
    await expect(inventorySummary).toBeVisible()
    await workspace.getByRole('button', { name: '打开音乐库与解析设置', exact: true }).click()
    await expect(concurrency).toHaveValue(String(nextConcurrency))
    await concurrency.fill(String(originalConcurrency))
    await management.getByRole('button', { name: '返回音乐库', exact: true }).click()
    await page.locator('[data-sidebar-source="local-library"]').click(); await workspace.getByRole('button', { name: '丢弃待保存选择并离开', exact: true }).click(); await expect(workspace).toBeHidden()
    await page.getByRole('button', { name: '曲目与原维护入口', exact: true }).click()
    await expect(page.getByRole('button', { name: '源写历史与恢复', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '搬迁历史与恢复', exact: true })).toBeVisible()
    await expect(page.getByTestId('local-library-view')).toContainText('尚未选择可用的 Roon 播放目标')
    const pickerRows = await app.evaluate(() => (globalThis as typeof globalThis & { __musicBridgeV39ControlledPicker?: { evidence(): { pid: number | null; closed: boolean; code: number | null; signal: string | null; failed: boolean }[] } }).__musicBridgeV39ControlledPicker?.evidence())
    expect(pickerRows).toHaveLength(1)
    expect(pickerRows![0]).toMatchObject({ closed: true, code: 0, signal: null, failed: false }); expect(pickerRows![0]!.pid).toBeGreaterThan(0)
    const network = await app.evaluate(() => (globalThis as typeof globalThis & { __musicBridgeUiE2eNetworkEvidence?: { installedBeforeWindow: boolean; blockedExternalAttempts: number } }).__musicBridgeUiE2eNetworkEvidence)
    expect(network?.installedBeforeWindow).toBe(true); expect(network?.blockedExternalAttempts).toBe(0)
    expect(hash(await readFile(audio))).toBe(hash(raw)); expect(errors).toEqual([])
    // 原单专辑全部业务断言完成后，独立合成七专辑检查真实布局；不替换原计数/操作。
    await page.locator('[data-sidebar-source="coverdrop"]').click()
    await coverDrop.getByRole('button', { name: '音乐库与解析设置', exact: true }).click()
    await expect(management).toBeVisible()
    await management.getByRole('button', { name: '选择文件夹并确认库结构', exact: true }).click()
    await expect(role.getByRole('heading', { name: '合成七专辑库', exact: true })).toBeVisible()
    await role.getByRole('combobox', { name: '目录角色', exact: true }).selectOption('catalog')
    await role.getByRole('button', { name: '确认角色并导入', exact: true }).click()
    await expect(role).toBeHidden()
    await expect(libraries.locator('button.coverdrop-library')).toHaveCount(2)
    await libraries.locator('button.coverdrop-library').filter({ hasText: '合成七专辑库' }).click()
    const layoutRootSettings = management.getByTestId('local-library-settings').getByRole('listitem').filter({ has: page.locator('strong').filter({ hasText: /^合成七专辑库$/u }) })
    await expect(layoutRootSettings).toHaveCount(1)
    await layoutRootSettings.getByRole('button', { name: '增量扫描', exact: true }).click()
    await expect(management.getByRole('list', { name: '扫描任务' }).getByRole('listitem').filter({ hasText: /已完成.*收录 7/u })).toHaveCount(1, { timeout: 45000 })
    await management.getByRole('button', { name: '返回音乐库', exact: true }).click()
    await expect(management).toBeHidden()
    await expect(coverDrop.locator('.coverdrop-stat strong')).toHaveText('7')
    const sevenCards = coverDrop.locator('.coverdrop-wall button[data-local-album-id]')
    async function layoutGeometry576() {
      return page.evaluate(() => {
        const workspace = document.querySelector<HTMLElement>('[data-testid="coverdrop-workspace"]')!
        const canvas = workspace.parentElement!, wall = workspace.querySelector<HTMLElement>('.coverdrop-wall')!
        const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
        const bounds = rect(workspace), port = rect(canvas)
        const inside = (r: ReturnType<typeof rect>) => r.width > 0 && r.height > 0 && r.left >= bounds.left - 1 && r.right <= bounds.right + 1 && r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1
        const hit = (element: HTMLElement) => { const r = rect(element), target = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2); return inside(r) && !!target && (target === element || element.contains(target)) }
        const cards = [...wall.querySelectorAll<HTMLElement>('button[data-local-album-id]')].map(element => ({ id: element.dataset.localAlbumId!, bounds: rect(element) }))
        const overlaps = cards.flatMap((a, index) => cards.slice(index + 1).filter(b => Math.min(a.bounds.right, b.bounds.right) - Math.max(a.bounds.left, b.bounds.left) > 1 && Math.min(a.bounds.bottom, b.bounds.bottom) - Math.max(a.bounds.top, b.bounds.top) > 1).map(b => [a.id, b.id]))
        const headerButtons = [...workspace.querySelectorAll<HTMLElement>('.coverdrop-header-actions button')]
        const heading = workspace.querySelector<HTMLElement>('#coverdrop-heading')!, filter = workspace.querySelector<HTMLElement>('.coverdrop-filter-bar')!
        const gear = workspace.querySelector<HTMLElement>('.coverdrop-sidebar-footer button[aria-label="音乐库与解析设置"]')!
        const player = document.querySelector<HTMLElement>('.global-player'), playerTop = player ? rect(player).top : innerHeight
        const grid = wall.querySelector<HTMLElement>('.local-album-grid')!
        return { viewport: { width: innerWidth, height: innerHeight }, canvas: { bounds: port, clientWidth: canvas.clientWidth, scrollWidth: canvas.scrollWidth, scrollLeft: canvas.scrollLeft }, workspace: bounds,
          wall: { bounds: rect(wall), clientWidth: wall.clientWidth, scrollWidth: wall.scrollWidth, scrollTop: wall.scrollTop, scrollHeight: wall.scrollHeight }, cards, overlaps, heading: rect(heading), filter: rect(filter), playerTop,
          measured: grid.dataset.gridMeasured === 'true', columns: grid.dataset.gridColumns,
          checks: { noHorizontal: canvas.scrollWidth <= canvas.clientWidth + 1 && wall.scrollWidth <= wall.clientWidth + 1 && canvas.scrollLeft === 0,
            exactCanvas: Math.abs(bounds.left - port.left) <= 1 && Math.abs(bounds.right - port.right) <= 1 && Math.abs(bounds.top - port.top) <= 1 && Math.abs(bounds.bottom - port.bottom) <= 1,
            headingInside: inside(rect(heading)), headerReachable: headerButtons.length > 0 && headerButtons.every(hit), filterInside: inside(rect(filter)), filterAbovePlayer: rect(filter).bottom <= playerTop + 1,
            settingsReachable: hit(gear), noOverlap: overlaps.length === 0, measured: grid.dataset.gridMeasured === 'true', rendered: cards.length > 0 }, sourceQualified: false, formalAcceptance: false }
      })
    }
    async function filterDockGeometry605() {
      return page.evaluate(() => {
        const workspace = document.querySelector<HTMLElement>('[data-testid="coverdrop-workspace"]')!
        const wall = workspace.querySelector<HTMLElement>('.coverdrop-wall')!, filter = workspace.querySelector<HTMLElement>('.coverdrop-filter-bar')!
        const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
        const bounds = rect(filter), wallBounds = rect(wall)
        const tabs = [...filter.querySelectorAll<HTMLElement>('.coverdrop-filter-tabs button')].map(rect)
        const search = filter.querySelector<HTMLElement>('.coverdrop-search-toggle, .coverdrop-search')!, searchBounds = rect(search)
        const hit = document.elementFromPoint((searchBounds.left + searchBounds.right) / 2, (searchBounds.top + searchBounds.bottom) / 2)
        return { wall: wallBounds, filter: bounds, tabs, search: searchBounds, expanded: !!filter.querySelector('input[type="search"]'),
          checks: { wallHasViewport: wallBounds.width > 0 && wallBounds.height > 0, filterReservesViewport: wallBounds.bottom <= bounds.top + 1,
            singleRow: tabs.length === 9 && tabs.every(tab => Math.abs(tab.top - tabs[0]!.top) <= 1 && Math.abs(tab.bottom - tabs[0]!.bottom) <= 1)
              && searchBounds.top < tabs[0]!.bottom && searchBounds.bottom > tabs[0]!.top,
            searchReachable: searchBounds.width > 0 && searchBounds.height > 0 && searchBounds.left >= bounds.left - 1 && searchBounds.right <= bounds.right + 1
              && !!hit && (hit === search || search.contains(hit)) }, sourceQualified: false, formalAcceptance: false }
      })
    }
    async function assertFilterDock605(width: number) {
      const wanted = { wallHasViewport: true, filterReservesViewport: true, singleRow: true, searchReachable: true }
      const tabs = coverDrop.getByRole('group', { name: 'CoverDrop 九种专辑筛选', exact: true })
      await expect(tabs.getByRole('button')).toHaveCount(9)
      await expect.poll(async () => (await filterDockGeometry605()).checks).toEqual(wanted)
      const collapsed = await filterDockGeometry605()
      // 只沿当前九个原按钮正常横滚，不点击改筛选，也不强制显示隐藏项。
      for (let index = 0; index < 9; index++) {
        const button = tabs.getByRole('button').nth(index); await button.scrollIntoViewIfNeeded()
        await expect.poll(() => button.evaluate(element => {
          const bounds = element.getBoundingClientRect(), filter = element.closest('.coverdrop-filter-bar')!.getBoundingClientRect()
          const hit = document.elementFromPoint((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2)
          return bounds.left >= filter.left - 1 && bounds.right <= filter.right + 1 && bounds.top >= filter.top - 1 && bounds.bottom <= filter.bottom + 1
            && !!hit && (hit === element || element.contains(hit))
        })).toBe(true)
      }
      const selected = tabs.locator('button[aria-pressed="true"]'); await expect(selected).toHaveCount(1)
      await selected.scrollIntoViewIfNeeded()
      await coverDrop.getByRole('button', { name: '展开 CoverDrop 搜索', exact: true }).click()
      await expect(coverDrop.locator('.coverdrop-search input[type="search"]')).toBeVisible()
      await expect.poll(async () => (await filterDockGeometry605()).checks).toEqual(wanted)
      const expanded = await filterDockGeometry605()
      // 原当前筛选动作收起搜索，query/root/filter不换，也不提交新搜索。
      await selected.click()
      await expect(coverDrop.locator('.coverdrop-search input[type="search"]')).toHaveCount(0)
      await expect.poll(async () => (await filterDockGeometry605()).checks).toEqual(wanted)
      const restored = await filterDockGeometry605()
      await test.info().attach(`coverdrop-filter-${width}-viewport605`, { body: Buffer.from(JSON.stringify({ collapsed, expanded, restored }, null, 2)), contentType: 'application/json' })
    }
    const originalSevenIds = new Set<string>()
    for (const size of [{ width: 1600, height: 1000 }, { width: 960, height: 640 }]) {
      await app.evaluate(({ BrowserWindow }, wanted) => {
        const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('musicbridge://app'))
        if (!window) throw new Error('本次原Main窗口未确认。')
        window.setSize(wanted.width, wanted.height)
      }, size)
      await expect(coverDrop.locator('.coverdrop-stat strong')).toHaveText('7')
      await expect.poll(async () => (await layoutGeometry576()).checks).toEqual({ noHorizontal: true, exactCanvas: true, headingInside: true, headerReachable: true, filterInside: true, filterAbovePlayer: true, settingsReachable: true, noOverlap: true, measured: true, rendered: true })
      if (size.width === 1600) {
        await expect(sevenCards).toHaveCount(7)
        for (const id of await sevenCards.evaluateAll(elements => elements.map(element => element.getAttribute('data-local-album-id')!))) originalSevenIds.add(id)
        expect(originalSevenIds.size).toBe(7)
      }
      const seen = new Set(await sevenCards.evaluateAll(elements => elements.map(element => element.getAttribute('data-local-album-id')!)))
      const wall = coverDrop.locator('.coverdrop-wall')
      // 正常用户滚至末尾，消费合法虚拟窗口，不强制挂载离屏项。
      await wall.evaluate(element => { element.scrollTop = element.scrollHeight })
      await expect.poll(async () => { for (const id of await sevenCards.evaluateAll(elements => elements.map(element => element.getAttribute('data-local-album-id')!))) seen.add(id); return [...seen].sort() }).toEqual([...originalSevenIds].sort())
      await expect.poll(async () => (await layoutGeometry576()).checks.noOverlap).toBe(true)
      await assertFilterDock605(size.width)
      const tailTitle = sevenCards.last().locator('.roon-album-copy strong')
      await tailTitle.scrollIntoViewIfNeeded()
      await expect.poll(() => tailTitle.evaluate(element => {
        const bounds = element.getBoundingClientRect(), wall = element.closest('.coverdrop-wall')!.getBoundingClientRect()
        const filter = element.closest('.coverdrop-main')!.querySelector('.coverdrop-filter-bar')!.getBoundingClientRect()
        const hit = document.elementFromPoint((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2)
        return bounds.width > 0 && bounds.height > 0 && bounds.left >= wall.left - 1 && bounds.right <= wall.right + 1 && bounds.top >= wall.top - 1 && bounds.bottom <= wall.bottom + 1
          && wall.bottom <= filter.top + 1 && !!hit && (hit === element || element.contains(hit))
      })).toBe(true)
      await test.info().attach(`coverdrop-seven-${size.width}-geometry576`, { body: Buffer.from(JSON.stringify(await layoutGeometry576(), null, 2)), contentType: 'application/json' })
      await test.info().attach(`coverdrop-seven-${size.width}-screen576`, { body: await page.screenshot(), contentType: 'image/png' })
      await coverDrop.getByRole('button', { name: '音乐库与解析设置', exact: true }).click()
      await expect(management).toBeVisible()
      await expect(management.getByRole('spinbutton', { name: '扫描并发（1–24）', exact: true })).toBeVisible()
      const tail = management.getByRole('button', { name: '下一页任务', exact: true })
      await tail.scrollIntoViewIfNeeded()
      await expect(tail).toBeVisible()
      const settingsGeometry = await tail.evaluate(element => {
        const host = element.closest<HTMLElement>('.coverdrop-management-host')!, r = element.getBoundingClientRect(), panel = host.getBoundingClientRect()
        const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)
        return { viewport: { width: innerWidth, height: innerHeight }, clientWidth: host.clientWidth, scrollWidth: host.scrollWidth, scrollTop: host.scrollTop, scrollHeight: host.scrollHeight,
          tail: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, noHorizontal: host.scrollWidth <= host.clientWidth + 1,
          tailReachable: r.left >= panel.left && r.right <= panel.right && r.top >= panel.top && r.bottom <= panel.bottom && !!hit && (hit === element || element.contains(hit)), sourceQualified: false, formalAcceptance: false }
      })
      expect(settingsGeometry.noHorizontal).toBe(true); expect(settingsGeometry.tailReachable).toBe(true)
      await test.info().attach(`coverdrop-settings-${size.width}-geometry576`, { body: Buffer.from(JSON.stringify(settingsGeometry, null, 2)), contentType: 'application/json' })
      await management.getByRole('button', { name: '返回音乐库', exact: true }).click()
      await expect(management).toBeHidden()
      await wall.evaluate(element => { element.scrollTop = 0 })
    }
    const allPickerRows = await app.evaluate(() => (globalThis as typeof globalThis & { __musicBridgeV39ControlledPicker?: { evidence(): { pid: number | null; closed: boolean; code: number | null; signal: string | null; failed: boolean }[] } }).__musicBridgeV39ControlledPicker?.evidence())
    expect(allPickerRows).toHaveLength(2)
    for (const row of allPickerRows!) { expect(row).toMatchObject({ closed: true, code: 0, signal: null, failed: false }); expect(row.pid).toBeGreaterThan(0) }
    for (const asset of layoutAssets) expect(hash(await readFile(asset.file))).toBe(asset.sha256)
    const finalNetwork = await app.evaluate(() => (globalThis as typeof globalThis & { __musicBridgeUiE2eNetworkEvidence?: { installedBeforeWindow: boolean; blockedExternalAttempts: number } }).__musicBridgeUiE2eNetworkEvidence)
    expect(finalNetwork?.installedBeforeWindow).toBe(true); expect(finalNetwork?.blockedExternalAttempts).toBe(0); expect(errors).toEqual([])
  } finally { await app.close() }
})
