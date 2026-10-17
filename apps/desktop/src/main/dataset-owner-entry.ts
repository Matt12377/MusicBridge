import { parentPort, workerData } from 'node:worker_threads'
import { channel as diagnosticsChannel } from 'node:diagnostics_channel'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachDatasetOwnerWorkerPort } from '../../../../packages/bridge-core/src/collection/dataset-owner-worker.js'
import { prepareOwnedDatasetDomain } from '../../../../packages/bridge-core/src/collection/dataset-domain.js'
import { loadRecordingDependenciesForOwner } from './recording-bootstrap.js'
import { mobileDsdOptionsForOwner } from './mobile-dsd-bootstrap.js'
import { parseDatasetOwnerWorkerData } from './dataset-owner-bootstrap.js'
import { installPhysicalResourceCoordinator } from '../../../../packages/bridge-core/src/stream/physical-resource-locks.js'

// 此入口只由受信任的Core组合层创建；不从Renderer、PATH或普通配置补造设备资格。
if (!parentPort) {
  throw new Error('数据集所有者启动身份无效。')
}
const { dataDirectory, resourcesDirectory, physicalResourceBuffer,sourceWritesPort, relocationMainPort, localWorkbenchNative } = parseDatasetOwnerWorkerData(workerData)
if (physicalResourceBuffer) installPhysicalResourceCoordinator(physicalResourceBuffer)
const env = process.env
const testMode = env.MUSIC_BRIDGE_CORE_TEST_MODE === '1'

attachDatasetOwnerWorkerPort(parentPort, {
  ...(sourceWritesPort?{privateSourceWritesPort:sourceWritesPort}:{}),
  ...(relocationMainPort ? { privateRelocationMainPort: relocationMainPort } : {}),
  async prepare(epoch, projection, sourceWritesMainActor) {
    const recordingDependencies = await loadRecordingDependenciesForOwner(env, {
      platform: process.platform,
      arch: process.arch,
      entryDirectory: path.dirname(fileURLToPath(import.meta.url)),
      resourcesDirectory,
    })
    const mobileDsd = mobileDsdOptionsForOwner(env, {
      platform: process.platform,
      arch: process.arch,
      entryDirectory: path.dirname(fileURLToPath(import.meta.url)),
      resourcesDirectory,
    }, dataDirectory)
    const prepared = prepareOwnedDatasetDomain({ dataDirectory, epoch, testMode, projection, recordingDependencies,
      ...(localWorkbenchNative ? { localWorkbenchNative } : {}),
      ...(sourceWritesMainActor ? { sourceWritesMainActor } : {}),
      ...(mobileDsd ? { mobileDsd } : {}) })
    // 仅可信同Owner观测者订阅；普通启动沿原factory Promise，不发布或构造私有对象消息。
    const observation = diagnosticsChannel('musicbridge.v39.source-service.observation')
    if (!observation.hasSubscribers) return prepared
    return prepared.then(domain => {
      if (observation.hasSubscribers) observation.publish({ datasetId: domain.datasetId, sourceService: domain.localSourceWrites })
      return domain
    })
  },
})
