import { Worker, type WorkerOptions } from 'node:worker_threads'
import { runCoreUtilityProcess, type DatasetOwnerFactory } from '../../../../packages/bridge-core/src/utility-main.js'
import { createDatasetOwnerClient } from '../../../../packages/bridge-core/src/collection/dataset-owner-client.js'
import { datasetOwnerEnvironment } from './dataset-owner-bootstrap.js'

/** Rust 能力只由同进程可信源码显式传入，不从环境、父启动数据或公开 IPC 选择。 */
export interface DesktopCoreHostOptions {
  env?: NodeJS.ProcessEnv
  rustReadonlyCollection?: Parameters<typeof runCoreUtilityProcess>[6]
  onRustReadonlyCoreController?: Parameters<typeof runCoreUtilityProcess>[7]
  dependencies?: {
    runCoreUtilityProcess?: typeof runCoreUtilityProcess
    createWorker?: (entry: URL, options: WorkerOptions) => Worker
  }
}

export function runDesktopCoreHost(options: DesktopCoreHostOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  // 所有者只继承构建/临时目录与收紧能力的合成开关，不传 Provider 凭据或任意配置。
  const datasetEnvironment = datasetOwnerEnvironment(env)
  const run = options.dependencies?.runCoreUtilityProcess ?? runCoreUtilityProcess
  const createWorker = options.dependencies?.createWorker ?? ((entry, workerOptions) => new Worker(entry, workerOptions))
  const createDatasetOwner: DatasetOwnerFactory = ({ projection, onFatal }) => {
    const worker = createWorker(new URL('./dataset-owner.js', import.meta.url), {
      name: 'MusicBridge Dataset Owner',
      env: datasetEnvironment,
      workerData: {
        dataDirectory: env.MUSIC_BRIDGE_DATA_DIRECTORY,
        resourcesDirectory: process.resourcesPath,
      },
    })
    return createDatasetOwnerClient({ worker, projection, onFatal })
  }
  const args = [env, undefined, undefined, undefined, null, createDatasetOwner] as const
  // 原入口维持恰六参数；显式能力仍由 utility 的既有准入和清理规则处理。
  if (options.onRustReadonlyCoreController !== undefined) {
    return run(...args, options.rustReadonlyCollection, options.onRustReadonlyCoreController)
  }
  if (options.rustReadonlyCollection !== undefined) return run(...args, options.rustReadonlyCollection)
  return run(...args)
}
