import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MessageChannelMain, utilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

/** 只供隔离编译启动器调用；私有能力只留在 Main global，Renderer 无入口。 */
export async function startPrivateMainHost(rust) {
  if (process.env.MUSIC_BRIDGE_UI_E2E !== '1' || process.env.MUSIC_BRIDGE_CORE_TEST_MODE !== '1' || process.env.MUSIC_BRIDGE_UI_E2E_OFFLINE !== '1') throw new Error('隔离 Main 必须采用离线合成模式。')
  const current = path.dirname(fileURLToPath(import.meta.url)), standard = path.join(current, 'core.js')
  const privateEntry = path.join(current, rust ? 'private-rust-core.js' : 'private-rust-node.js')
  const observations = [], main = [], replies = new Map()
  let control, final, coreExit, sequence = 0
  const save = () => {
    const profile = process.env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR
    if (!profile || !path.isAbsolute(profile)) throw new Error('隔离证据目录无效。')
    writeFileSync(path.join(profile, 'rust008-main-evidence.json'), JSON.stringify({ observations: [...observations], main: [...main], final, coreExit, rustConfigured: rust }) + '\n')
  }
  const original = utilityProcess.fork.bind(utilityProcess)
  utilityProcess.fork = (entry, args, options) => {
    if (entry !== standard) throw new Error('隔离 Main 不允许未知 Core 入口。')
    main.push({ sequence: ++sequence, event: 'main.coreFork', entry: 'production-CoreSupervisor-static-private-entry' })
    const channel = new MessageChannelMain(), child = original(privateEntry, args, { ...options, stdio: 'pipe', env: { ...options.env,
      TMPDIR: process.env.TMPDIR,
      ...(process.env.DEV_BUILD_ROOT === undefined ? {} : { DEV_BUILD_ROOT: process.env.DEV_BUILD_ROOT }),
      ...(process.env.DEV_CACHE_ROOT === undefined ? {} : { DEV_CACHE_ROOT: process.env.DEV_CACHE_ROOT }) } })
    // 合成进程的启动异常只进入私有审计，不改变生产公共回执。
    child.stderr?.on('data', chunk => { main.push({ sequence: ++sequence, event: 'main.coreStderr', text: String(chunk) }) })
    child.once('spawn', () => { main.push({ sequence: ++sequence, event: 'main.coreSpawn', pid: child.pid }) })
    control = channel.port2
    control.on('message', ({ data }) => {
      if (data.type === 'rust008.observation') observations.push(data.value)
      if (data.type === 'rust008.reply') replies.set(data.id, data)
      if (data.type === 'rust008.final') { final = data.value; save() }
    })
    control.start()
    const post = child.postMessage.bind(child)
    child.postMessage = (message, ports) => {
      if (message?.type !== 'musicbridge.core.port' || !ports || ports.length !== 2 || ports[0] === ports[1]) throw new Error('隔离宿主必须保留公共及源写专用启动端口。')
      post(message, [...ports, channel.port1])
    }
    child.once('exit', code => { coreExit = code; main.push({ sequence: ++sequence, event: 'main.coreExit', pid: child.pid, code }); save() })
    return child
  }
  globalThis.__rust008Host = {
    async control(operation, parameters = {}) {
      if (!control || !['status', 'refresh', 'invalidate', 'oracleList'].includes(operation)) throw new Error('私有控制不可用。')
      const id = randomUUID(); control.postMessage({ id, operation, ...parameters })
      const deadline = performance.now() + 30_000
      while (!replies.has(id)) {
        if (performance.now() >= deadline) throw new Error('私有控制等待超时。')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const result = replies.get(id); replies.delete(id)
      if (!result.ok) throw Object.assign(new Error('私有控制拒绝。'), { code: result.code })
      return result.result
    },
    snapshot() { return { observations: [...observations], main: [...main], final, coreExit, rustConfigured: rust } },
  }
  await import(pathToFileURL(path.join(current, 'index.js')).href)
}
