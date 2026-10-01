import { parentPort, workerData } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachDatasetOwnerWorkerPort } from '../../../../packages/bridge-core/src/collection/dataset-owner-worker.js'
import { prepareOwnedDatasetDomain } from '../../../../packages/bridge-core/src/collection/dataset-domain.js'
import { loadRecordingDependenciesForOwner } from './recording-bootstrap.js'
import { parseDatasetOwnerWorkerData } from './dataset-owner-bootstrap.js'

// 此入口只由受信任的Core组合层创建；不从Renderer、PATH或普通配置补造设备资格。
if (!parentPort) {
  throw new Error('数据集所有者启动身份无效。')
}
const { dataDirectory, resourcesDirectory } = parseDatasetOwnerWorkerData(workerData)
const env = process.env
const testMode = env.MUSIC_BRIDGE_CORE_TEST_MODE === '1'

attachDatasetOwnerWorkerPort(parentPort, {
  async prepare(epoch, projection) {
    const recordingDependencies = await loadRecordingDependenciesForOwner(env, {
      platform: process.platform,
      arch: process.arch,
      entryDirectory: path.dirname(fileURLToPath(import.meta.url)),
      resourcesDirectory,
    })
    return prepareOwnedDatasetDomain({ dataDirectory, epoch, testMode, projection, recordingDependencies })
  },
})
