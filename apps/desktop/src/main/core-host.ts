import { Worker, type WorkerOptions } from 'node:worker_threads'
import { runCoreUtilityProcess, type DatasetOwnerFactory } from '../../../../packages/bridge-core/src/utility-main.js'
import { createDatasetOwnerClient } from '../../../../packages/bridge-core/src/collection/dataset-owner-client.js'
import type { DatasetOwnerEndpoint } from '../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { datasetOwnerEnvironment } from './dataset-owner-bootstrap.js'
import type { OptionalRustReadonlyManager } from '../../../../packages/bridge-core/src/rust-core/optional-readonly-manager.js'
import { installCollectionReadonlyCoreBridge, type CollectionReadonlyCoreParent } from './collection-readonly-core-bridge.js'
import { physicalResourceLocks } from '../../../../packages/bridge-core/src/stream/physical-resource-locks.js'

/** Rust 能力只由同进程可信源码显式传入，不从环境、父启动数据或公开 IPC 选择。 */
export interface DesktopCoreHostOptions {
  env?: NodeJS.ProcessEnv
  optionalReadonlyManager?: OptionalRustReadonlyManager
  rustReadonlyCollection?: Parameters<typeof runCoreUtilityProcess>[6]
  onRustReadonlyCoreController?: Parameters<typeof runCoreUtilityProcess>[7]
  createRustReadonlyCollection?: Parameters<typeof runCoreUtilityProcess>[8]
  dependencies?: {
    runCoreUtilityProcess?: typeof runCoreUtilityProcess
    createWorker?: (entry: URL, options: WorkerOptions) => Worker
    decorateDatasetOwner?: (owner: DatasetOwnerEndpoint) => DatasetOwnerEndpoint
  }
}

export function runDesktopCoreHost(options: DesktopCoreHostOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  // 所有者只继承构建/临时目录与收紧能力的合成开关，不传 Provider 凭据或任意配置。
  const datasetEnvironment = datasetOwnerEnvironment(env)
  const run = options.dependencies?.runCoreUtilityProcess ?? runCoreUtilityProcess
  const createWorker = options.dependencies?.createWorker ?? ((entry, workerOptions) => new Worker(entry, workerOptions))
  if (options.optionalReadonlyManager) {
    const parent = (process as unknown as { parentPort?: CollectionReadonlyCoreParent }).parentPort
    if (parent) installCollectionReadonlyCoreBridge(options.optionalReadonlyManager, parent)
  }
  const createDatasetOwner: DatasetOwnerFactory = ({ projection, onFatal, privateSourceWritesPort, privateRelocationMainPort }) => {
    const worker = createWorker(new URL('./dataset-owner.js', import.meta.url), {
      name: 'MusicBridge Dataset Owner',
      env: datasetEnvironment,
      workerData: {
        dataDirectory: env.MUSIC_BRIDGE_DATA_DIRECTORY,
        resourcesDirectory: process.resourcesPath,
        physicalResourceBuffer: physicalResourceLocks.buffer,
        ...(privateSourceWritesPort ? { sourceWritesPort: privateSourceWritesPort } : {}),
        ...(privateRelocationMainPort ? { relocationMainPort: privateRelocationMainPort } : {}),
      },
      ...(privateSourceWritesPort || privateRelocationMainPort ? { transferList: [...(privateSourceWritesPort ? [privateSourceWritesPort] : []), ...(privateRelocationMainPort ? [privateRelocationMainPort] : [])] } : {}),
    })
    let owner: ReturnType<typeof createDatasetOwnerClient>
    owner = createDatasetOwnerClient({ worker, projection,
      onFatal: reason => onFatal(reason, () => owner.fatalDrain()),
    })
    try {
      const observed = options.dependencies?.decorateDatasetOwner ? options.dependencies.decorateDatasetOwner(owner) : owner
      if (!observed || ['prepare', 'dispatch', 'commitBoot', 'close'].some(key =>
        typeof observed[key as keyof DatasetOwnerEndpoint] !== 'function')) throw new Error('可信 Owner 装饰无效。')
      const decorated = options.optionalReadonlyManager?.decorate(observed) ?? observed
      if (!decorated || ['prepare', 'dispatch', 'commitBoot', 'close'].some(key =>
        typeof decorated[key as keyof DatasetOwnerEndpoint] !== 'function')) throw new Error('可信 Owner 装饰无效。')
      return decorated
    } catch (error) {
      // 装饰失败仍先交付清理端点；utility 原启动 catch 必须等唯一 Owner 关闭回执。
      return { prepare: () => Promise.reject(error), dispatch: () => Promise.reject(error),
        commitBoot: () => Promise.reject(error), close: () => owner.close() }
    }
  }
  const args = [env, undefined, undefined, undefined, null, createDatasetOwner] as const
  // 原入口维持恰六参数；显式能力仍由 utility 的既有准入和清理规则处理。
  if (options.createRustReadonlyCollection !== undefined) {
    return run(...args, options.rustReadonlyCollection, options.onRustReadonlyCoreController, options.createRustReadonlyCollection)
  }
  if (options.onRustReadonlyCoreController !== undefined) {
    return run(...args, options.rustReadonlyCollection, options.onRustReadonlyCoreController)
  }
  if (options.rustReadonlyCollection !== undefined) return run(...args, options.rustReadonlyCollection)
  return run(...args)
}
