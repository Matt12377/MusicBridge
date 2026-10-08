import path from 'node:path'
import { MessagePort } from 'node:worker_threads'
import { PHYSICAL_RESOURCE_BUFFER_BYTES } from '../../../../packages/bridge-core/src/stream/physical-resource-locks.js'

export function datasetOwnerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of ['NODE_ENV', 'TMPDIR', 'DEV_BUILD_ROOT', 'DEV_CACHE_ROOT', 'NODE_COMPILE_CACHE',
    'LANG', 'LC_ALL', 'TZ', 'MUSIC_BRIDGE_CORE_TEST_MODE', 'MUSIC_BRIDGE_UI_E2E',
    'MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE', 'MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE']) {
    const value = env[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

export function parseDatasetOwnerWorkerData(value: unknown): { dataDirectory: string; resourcesDirectory: string; physicalResourceBuffer?: SharedArrayBuffer;sourceWritesPort?:MessagePort; relocationMainPort?: MessagePort } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('数据集所有者启动身份无效。')
  const input = value as Record<string, unknown>
  if (![2,3,4,5].includes(Object.keys(input).length) || Object.keys(input).some(key => !['dataDirectory', 'resourcesDirectory', 'physicalResourceBuffer','sourceWritesPort','relocationMainPort'].includes(key))
    || Object.hasOwn(input,'sourceWritesPort') && !(input.sourceWritesPort instanceof MessagePort)
    || Object.hasOwn(input, 'relocationMainPort') && (!(input.relocationMainPort instanceof MessagePort) || input.relocationMainPort === input.sourceWritesPort)
    || Object.hasOwn(input, 'physicalResourceBuffer') && (!(input.physicalResourceBuffer instanceof SharedArrayBuffer) || input.physicalResourceBuffer.byteLength !== PHYSICAL_RESOURCE_BUFFER_BYTES)
    || typeof input.dataDirectory !== 'string' || !path.isAbsolute(input.dataDirectory)
    || input.dataDirectory.length > 1024 || input.dataDirectory.includes('\0')
    || typeof input.resourcesDirectory !== 'string' || !path.isAbsolute(input.resourcesDirectory)
    || input.resourcesDirectory.length > 1024 || input.resourcesDirectory.includes('\0')) {
    throw new Error('数据集所有者启动身份无效。')
  }
  return { dataDirectory: input.dataDirectory, resourcesDirectory: input.resourcesDirectory, ...(input.physicalResourceBuffer instanceof SharedArrayBuffer ? { physicalResourceBuffer: input.physicalResourceBuffer } : {}),...(input.sourceWritesPort instanceof MessagePort?{sourceWritesPort:input.sourceWritesPort}:{}), ...(input.relocationMainPort instanceof MessagePort ? { relocationMainPort: input.relocationMainPort } : {}) }
}
