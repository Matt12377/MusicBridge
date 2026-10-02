import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { UtilityPort } from '../../../../packages/bridge-core/src/utility-main.js'

if (!parentPort) throw new Error('受控 Main 组件缺少父端口。')
const parent = parentPort, config = workerData as { entry: string; buildRoot: string }
if (!path.isAbsolute(config.entry) || path.dirname(config.entry) !== path.join(config.buildRoot, 'main')) throw new Error('受控宿主只准许冻结编译入口。')
const adapters = new Map<MessagePort, UtilityPort>()
function adapt(port: MessagePort): UtilityPort {
  let adapter = adapters.get(port)
  if (!adapter) {
    adapter = { on(_name, callback) { return port.on('message', data => callback({ data })) }, start() { port.start() }, postMessage(value) { port.postMessage(value) } }
    adapters.set(port, adapter)
  }
  return adapter
}
Object.defineProperty(process, 'resourcesPath', { value: config.buildRoot })
Object.defineProperty(process, 'parentPort', { value: {
  once(_name: string, listener: (event: { data: unknown; ports: UtilityPort[] }) => void) {
    parent.once('message', (value: { type: string; data: unknown; ports: MessagePort[] }) => {
      if (value.type !== 'rust008.bind') throw new Error('受控宿主启动消息无效。')
      listener({ data: value.data, ports: value.ports.map(adapt) })
    })
  },
} })
await import(pathToFileURL(config.entry).href)
