import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const externalTemporaryRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
const kinds = new Set(['default-node', 'node-diagnostic', 'rust-diagnostic', 'pin-rejected'])
const evidencePrefix = 'RUST012_EVIDENCE '
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (root, value) => { const relative = path.relative(root, value); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) }

/** 输入kind仅描述候选身份；不传递模式、入口、二进制或pin选择给应用。 */
export async function validateRustPackagedRouteRunOptions(supplied) {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('候选运行参数无效。')
  const fields = Object.getOwnPropertyDescriptors(supplied)
  const names = ['executable', 'expectedExecutableSha256', 'evidenceDirectory', 'kind']
  if (Reflect.ownKeys(supplied).length !== names.length || !names.every(name => fields[name]?.enumerable && Object.hasOwn(fields[name], 'value'))) throw new Error('候选运行只接受冻结的四项参数。')
  const options = Object.fromEntries(names.map(name => [name, fields[name].value]))
  if (!kinds.has(options.kind) || typeof options.expectedExecutableSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedExecutableSha256)
    || typeof options.executable !== 'string' || !path.isAbsolute(options.executable) || path.resolve(options.executable) !== options.executable
    || !/\.app\/Contents\/MacOS\/[^/]+$/.test(options.executable) || options.executable.includes('\0')
    || typeof options.evidenceDirectory !== 'string' || !path.isAbsolute(options.evidenceDirectory) || path.resolve(options.evidenceDirectory) !== options.evidenceDirectory
    || !inside(externalTemporaryRoot, options.evidenceDirectory) || options.evidenceDirectory.includes('\0')) throw new Error('候选身份或外置证据目录未准入。')
  // 先做词法范围检查，之后只查询已准入的候选和外置目录。
  const volume = await lstat('/Volumes/LifeWeave'), temporary = await lstat(externalTemporaryRoot)
  if (!volume.isDirectory() || !temporary.isDirectory() || volume.dev !== temporary.dev || await realpath('/Volumes/LifeWeave') !== '/Volumes/LifeWeave') throw new Error('外置LifeWeave卷不可用。')
  const executable = await lstat(options.executable)
  if (!executable.isFile() || executable.isSymbolicLink() || (executable.mode & 0o111) === 0 || await realpath(options.executable) !== options.executable
    || sha(await readFile(options.executable)) !== options.expectedExecutableSha256) throw new Error('候选可执行文件身份不一致。')
  // 逐级确认真实目录，再创建下一层，不能先穿过symlink写入范围外。
  let current = externalTemporaryRoot
  if (await realpath(current) !== current) throw new Error('外置临时根真实身份无效。')
  for (const segment of path.relative(externalTemporaryRoot, options.evidenceDirectory).split(path.sep)) {
    current = path.join(current, segment)
    try { await mkdir(current, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const identity = await lstat(current)
    if (!identity.isDirectory() || identity.isSymbolicLink() || await realpath(current) !== current || identity.dev !== temporary.dev) throw new Error('外置证据目录真实身份无效。')
  }
  if (await realpath(options.evidenceDirectory) !== options.evidenceDirectory || (await lstat(options.evidenceDirectory)).dev !== temporary.dev) throw new Error('外置证据目录真实身份无效。')
  return Object.freeze(options)
}

/** 直接启动签后.app可执行文件，只有mock keychain参数；不加载外置JavaScript或调试端口。 */
export async function runRustPackagedRouteCandidate(supplied) {
  const options = await validateRustPackagedRouteRunOptions(supplied)
  const tmpDirectory = await mkdtemp(path.join(options.evidenceDirectory, 'runtime-tmp-'))
  const profileDirectory = await mkdtemp(path.join(tmpDirectory, options.kind === 'default-node' ? 'musicbridge-task036-startup-' : 'musicbridge-ui-diagnostics-'))
  const environment = { TMPDIR: tmpDirectory, DEV_BUILD_ROOT: '/Volumes/LifeWeave/Developer/CommandLine', DEV_CACHE_ROOT: '/Volumes/LifeWeave/Developer/CommandLine/Caches', LANG: 'zh_CN.UTF-8' }
  if (options.kind === 'default-node') Object.assign(environment, { MUSIC_BRIDGE_STARTUP_TEST: '1', MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: profileDirectory })
  else Object.assign(environment, { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profileDirectory })
  const startedAt = new Date().toISOString(), events = [], stdout = [], stdoutHash = createHash('sha256'), stderrHash = createHash('sha256'), decoder = new StringDecoder('utf8')
  let stdoutBytes = 0, stderrBytes = 0, buffer = '', parseErrors = 0, timedOut = false, forceKilled = false, spawnFailed = false
  let stderrMarkerTail = '', stderrStartupFailed = false
  const child = childProcess.spawn(options.executable, ['--use-mock-keychain'], { cwd: path.dirname(options.executable), env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  const mainPid = child.pid ?? null
  const mainExit = await new Promise(resolve => {
    const timer = setTimeout(() => { timedOut = true; forceKilled = true; child.kill('SIGKILL') }, 90_000)
    child.once('error', () => { spawnFailed = true })
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length
      stdoutHash.update(chunk)
      if (stdoutBytes > 32 * 1024 * 1024) { forceKilled = true; child.kill('SIGKILL'); return }
      stdout.push(chunk); buffer += decoder.write(chunk)
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
        if (line.startsWith(evidencePrefix)) {
          try { events.push(JSON.parse(line.slice(evidencePrefix.length))) } catch { parseErrors++ }
        }
      }
    })
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length; stderrHash.update(chunk)
      // 原Main bootstrap失败写stderr；只识别公开固定ASCII标记，保留有限尾部而不持有私有错误字节。
      const marker = 'DESKTOP_STARTUP_FAIL', text = stderrMarkerTail + chunk.toString('utf8')
      if (text.includes(marker)) stderrStartupFailed = true
      stderrMarkerTail = text.slice(-(marker.length - 1))
    })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
  })
  buffer += decoder.end()
  if (buffer.startsWith(evidencePrefix)) parseErrors++
  const stdoutData = Buffer.concat(stdout)
  const executableSha256After = sha(await readFile(options.executable))
  const receipt = { schemaVersion: 1, ...options, executableSha256: options.expectedExecutableSha256, executableSha256After, profileDirectory, tmpDirectory, startedAt, mainPid, events,
    mainExit, timedOut, forceKilled, parseErrors, stdoutSha256: stdoutHash.digest('hex'), stderrSha256: stderrHash.digest('hex'), stdoutBytes, stderrBytes,
    startupReady: stdoutData.includes('DESKTOP_STARTUP_READY'), startupFailed: stdoutData.includes('DESKTOP_STARTUP_FAIL') || stderrStartupFailed,
    completion: spawnFailed ? 'spawn-error' : timedOut ? 'timeout' : forceKilled ? 'forced-close' : 'closed' }
  // 非诊断输出不落盘；仅保留合成闭集证据及摘要，避免复制SDK错误栈。
  await writeFile(path.join(options.evidenceDirectory, 'runtime-evidence.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  return receipt
}
