import { Worker } from 'node:worker_threads'
import { runCoreUtilityProcess } from '../../../../packages/bridge-core/src/utility-main.js'
import { createDatasetOwnerClient } from '../../../../packages/bridge-core/src/collection/dataset-owner-client.js'
import { datasetOwnerEnvironment } from './dataset-owner-bootstrap.js'

// 所有者只继承构建/临时目录与收紧能力的合成开关，不传Provider凭据或任意配置。
const datasetEnvironment = datasetOwnerEnvironment(process.env)

void runCoreUtilityProcess(process.env, undefined, undefined, undefined, null, ({ projection, onFatal }) => {
  const worker = new Worker(new URL('./dataset-owner.js', import.meta.url), {
    name: 'MusicBridge Dataset Owner',
    env: datasetEnvironment,
    workerData: {
      dataDirectory: process.env.MUSIC_BRIDGE_DATA_DIRECTORY,
      resourcesDirectory: process.resourcesPath,
    },
  })
  return createDatasetOwnerClient({ worker, projection, onFatal })
})
