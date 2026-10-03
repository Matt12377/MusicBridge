import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual, types } from 'node:util'
import { projectCollectionFilter } from '../../../../packages/bridge-core/src/rust-core/collection-query.js'
import { validateIpcRequest, validateIpcResponseForCommand } from '@music-bridge/contracts'

export const RENDERER_RUN_KEYS = ['node-fresh', 'node-cold', 'rust-fresh', 'rust-cold'] as const
export type RendererRunKey = typeof RENDERER_RUN_KEYS[number]
export interface RendererArtifactIdentity { path: string; sha256: string; bytes: number }
export const rendererDigest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
export const rendererJsonDigest = (value: unknown): string => rendererDigest(JSON.stringify(value))
export const rendererSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
export function rendererCheck(value: unknown): asserts value {
  if (!value) throw Object.assign(new Error('原控件实际证据未准入。'), { code: 'RUST_PACKAGED_RENDERER_EVIDENCE_REJECTED' })
}
export function rendererSame(left: unknown, right: unknown): void { rendererCheck(isDeepStrictEqual(left, right)) }
export function rendererExact(value: any, keys: readonly string[]): void {
  rendererCheck(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)))
}
export function rendererOnlyData(value: unknown, depth = 0, visiting = new Set<object>()): void {
  rendererCheck(depth < 64)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { rendererCheck(Number.isFinite(value)); return }
  rendererCheck(typeof value === 'object' && value !== null && !types.isProxy(value) && !visiting.has(value))
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
  rendererCheck(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null)
  rendererCheck(Object.getOwnPropertySymbols(value).length === 0); visiting.add(value)
  const fields = Object.getOwnPropertyDescriptors(value)
  rendererCheck(!array || Object.keys(fields).length === (value as unknown[]).length + 1)
  for (const [key, field] of Object.entries(fields)) {
    if (array && key === 'length') continue
    rendererCheck(field.enumerable && Object.hasOwn(field, 'value') && (!array || /^(?:0|[1-9][0-9]*)$/u.test(key)))
    rendererOnlyData(field.value, depth + 1, visiting)
  }
  visiting.delete(value)
}
export function rendererExternalPath(value: unknown): asserts value is string {
  rendererCheck(typeof value === 'string' && value.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')
    && path.resolve(value) === value && value.length <= 1024 && !value.includes('\0'))
}
export function rendererBytesAt(file: unknown, limit = 64 * 1024 * 1024, executable = false, allowEmpty = false): Buffer {
  rendererExternalPath(file); rendererCheck(realpathSync(file) === file)
  const before = lstatSync(file, { bigint: true })
  rendererCheck(before.isFile() && before.nlink === 1n && (allowEmpty || before.size > 0n) && before.size <= BigInt(limit)
    && (before.mode & 0o022n) === 0n && (!executable || (before.mode & 0o111n) !== 0n))
  const bytes = readFileSync(file), after = lstatSync(file, { bigint: true })
  rendererCheck(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].every(key => before[key as keyof typeof before] === after[key as keyof typeof after]))
  return bytes
}
export function rendererArtifact(identity: any, expected: any): any {
  rendererExact(identity, ['path', 'sha256', 'bytes']); rendererExact(expected, ['path', 'sha256', 'bytes'])
  rendererSame(identity, expected); rendererCheck(rendererSha(identity.sha256) && Number.isSafeInteger(identity.bytes) && identity.bytes > 0)
  const bytes = rendererBytesAt(identity.path)
  rendererCheck(bytes.length === identity.bytes && rendererDigest(bytes) === identity.sha256)
  const value = JSON.parse(bytes.toString()); rendererOnlyData(value); return value
}
export interface RendererCostSample {
  runKey: RendererRunKey; mainPid: number; clockId: string; requestId: string; command: string; actionId: string | null
  workload: string; requestJsonBytes: number; replyJsonBytes: number; requestSha256: string; dtoSha256: string; durationMs: number; route: 'Node' | 'Rust'
}
export const RENDERER_COST_LIMITATIONS = [
  '固定26型号的Main实际请求往返；不代表100/2000/5000规模。',
  'DOM等待单列；未独立分解Renderer、Core、TS校验或Rust查询耗时。',
  'Main RTT包含候选被动观察及同步Core日志输送开销，不等同关闭诊断的生产时延。',
  '保留本profile实际UUID与完整DTO；不据此宣称所有路径加速或完整迁移。',
] as const
export interface RendererCostEvidence {
  schemaVersion: 1; task: 'RUST-013'; scope: 'MAIN_REQUEST_REPLY_ROUNDTRIP_ONLY'; models: 26
  samples: RendererCostSample[]
  summary: { runKey: RendererRunKey; workload: string; count: number; medianMs: number; minMs: number; maxMs: number }[]
  driverWait: { runKey: RendererRunKey; actionId: string | null; pollCount: number; elapsedMs: number }[]
  limitations: readonly string[]
}
export interface RendererCostExpectedIdentity { artifact: RendererArtifactIdentity; runs: Record<RendererRunKey, RendererArtifactIdentity> }
export function rendererMedian(values: readonly number[]): number {
  rendererCheck(values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0))
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
function routeFor(events: any[], request: any, reply: any): 'Node' | 'Rust' {
  const core = events.filter(event => event.event === 'core.publicReply' && event.data.reply?.id === request.id)
  rendererCheck(core.length === 1); rendererSame(core[0].data.reply, reply)
  const node = events.filter(event => event.event === 'node.reply' && event.data.requestId === request.id)
  const rust = events.filter(event => event.event === 'rust.request' && event.data.frame?.operation === 'dispatch' && event.data.frame?.payload?.request?.id === request.id)
  rendererCheck(node.length + rust.length === 1)
  if (node.length) { rendererCheck(node[0].data.command === request.command); rendererSame(node[0].data.result, reply.result); return 'Node' }
  const dispatch = rust[0], frame = dispatch.data.frame
  rendererExact(frame, ['protocolVersion', 'requestId', 'epoch', 'datasetId', 'snapshotId', 'sequence', 'operation', 'payload'])
  rendererExact(frame.payload, ['request', 'filterProjection'])
  const owner=events.filter(event=>event.event==='node.prepared'&&event.pid===dispatch.pid)
  rendererCheck(owner.length===1&&owner[0].data.identity.datasetId===frame.datasetId&&owner[0].data.identity.epoch===frame.epoch)
  rendererSame(frame.payload.request,Object.hasOwn(request,'expectedDatasetId')?request:{...request,expectedDatasetId:owner[0].data.identity.datasetId})
  rendererSame(frame.payload.filterProjection, projectCollectionFilter(request.payload.filter ?? {}))
  const acknowledged = events.filter(event => event.event === 'rust.validated-reply' && event.data.pid === dispatch.data.pid && event.data.frame?.requestId === frame.requestId)
  rendererCheck(acknowledged.length === 1 && acknowledged[0].pid === dispatch.pid && acknowledged[0].sequence > dispatch.sequence)
  const ack = acknowledged[0].data.frame
  rendererExact(ack, ['protocolVersion', 'requestId', 'epoch', 'datasetId', 'snapshotId', 'sequence', 'operation', 'ok', 'result'])
  rendererCheck(frame.protocolVersion === 2 && ack.protocolVersion === 2 && ack.ok === true)
  for (const key of ['requestId', 'epoch', 'datasetId', 'snapshotId', 'sequence', 'operation']) rendererCheck(ack[key] === frame[key])
  rendererSame(ack.result, reply.result); return 'Rust'
}
/** 纯计算入口供Gate从实际收据生成成本。其返回值本身不是实际产物准入。 */
export function deriveRustPackagedRendererCostEvidence(runs: Record<RendererRunKey, any>): RendererCostEvidence {
  rendererOnlyData(runs); rendererExact(runs, RENDERER_RUN_KEYS)
  const samples: RendererCostSample[] = [], driverWait: RendererCostEvidence['driverWait'] = []
  for (const runKey of RENDERER_RUN_KEYS) {
    const runtime = runs[runKey], events = runtime.events
    rendererCheck(Number.isSafeInteger(runtime.mainPid) && runtime.mainPid > 0 && Array.isArray(events))
    const main = events.filter((event: any) => event.actor === 'main')
    rendererCheck(main.length > 0 && main.every((event: any) => event.pid === runtime.mainPid))
    const requests = new Map<string, { event: any; phase: string }>(), seen = new Set<string>(), waits = new Set<string | null>()
    let phase = '', previousSequence = 0, previousTime = 0
    for (const event of main) {
      rendererCheck(Number.isSafeInteger(event.sequence) && event.sequence === ++previousSequence && Number.isFinite(event.elapsedMs) && event.elapsedMs >= previousTime)
      previousTime = event.elapsedMs
      if (event.event === 'main.probePhase') {
        rendererCheck(['fresh', 'seeded', 'matrix', 'policy', 'stale', 'refreshed', 'cold'].includes(event.data.phase))
        phase = event.data.phase
      }
      if (event.event === 'main.domSettled') {
        const { actionId, pollCount, elapsedMs } = event.data
        rendererCheck((actionId === null || typeof actionId === 'string' && actionId.length > 0) && !waits.has(actionId) && Number.isSafeInteger(pollCount) && pollCount > 0 && Number.isFinite(elapsedMs) && elapsedMs >= 0)
        waits.add(actionId); driverWait.push({ runKey, actionId, pollCount, elapsedMs })
      }
      if (event.event === 'main.request') {
        const request = event.data.request
        rendererCheck(validateIpcRequest(request).ok && !seen.has(request.id)); seen.add(request.id)
        rendererCheck(event.data.requestJsonBytes === Buffer.byteLength(JSON.stringify(request)) && event.data.requestSha256 === rendererJsonDigest(request))
        requests.set(request.id, { event, phase })
      }
      if (event.event !== 'main.response') continue
      const data = event.data, pair = requests.get(data.requestId)
      rendererCheck(pair); requests.delete(data.requestId)
      const request = pair.event.data.request, reply = data.reply
      rendererCheck(data.command === request.command && reply.id === request.id && data.actionId === pair.event.data.actionId
        && Number.isFinite(data.durationMs) && data.durationMs >= 0 && data.durationMs <= event.elapsedMs - pair.event.elapsedMs + 0.000001
        && data.replyJsonBytes === Buffer.byteLength(JSON.stringify(reply)) && data.replySha256 === rendererJsonDigest(reply))
      if (!['collection.list', 'collection.detail'].includes(request.command) || !['matrix', 'stale', 'refreshed', 'cold'].includes(pair.phase)) continue
      rendererCheck(reply.ok === true && validateIpcResponseForCommand(reply, request.command).ok)
      rendererCheck(data.actionId === null || typeof data.actionId === 'string' && data.actionId.length > 0)
      const workload = JSON.stringify({ command: request.command, payload: request.payload })
      samples.push({ runKey, mainPid: runtime.mainPid, clockId: `main:${runtime.mainPid}`, requestId: request.id, command: request.command,
        actionId: data.actionId, workload, requestJsonBytes: pair.event.data.requestJsonBytes, replyJsonBytes: data.replyJsonBytes,
        requestSha256: pair.event.data.requestSha256, dtoSha256: rendererJsonDigest(reply.result), durationMs: data.durationMs, route: routeFor(events, request, reply) })
    }
    rendererCheck(requests.size === 0 && samples.some(sample => sample.runKey === runKey) && driverWait.some(wait => wait.runKey === runKey))
  }
  const groups = new Map<string, RendererCostSample[]>()
  for (const sample of samples) {
    const key = JSON.stringify([sample.runKey, sample.workload]), group = groups.get(key) ?? []
    group.push(sample); groups.set(key, group)
  }
  const summary = [...groups.values()].map(group => ({ runKey: group[0]!.runKey, workload: group[0]!.workload, count: group.length,
    medianMs: rendererMedian(group.map(sample => sample.durationMs)), minMs: Math.min(...group.map(sample => sample.durationMs)), maxMs: Math.max(...group.map(sample => sample.durationMs)) }))
  return { schemaVersion: 1, task: 'RUST-013', scope: 'MAIN_REQUEST_REPLY_ROUNDTRIP_ONLY', models: 26, samples, summary, driverWait, limitations: [...RENDERER_COST_LIMITATIONS] }
}
export function acceptRustPackagedRendererCostEvidence(report: unknown, expectedIdentity: RendererCostExpectedIdentity): true {
  rendererOnlyData(report); rendererOnlyData(expectedIdentity)
  rendererExact(report, ['schemaVersion', 'task', 'scope', 'models', 'samples', 'summary', 'driverWait', 'limitations'])
  rendererExact(expectedIdentity, ['artifact', 'runs']); rendererExact(expectedIdentity.runs, RENDERER_RUN_KEYS)
  const runs = Object.fromEntries(RENDERER_RUN_KEYS.map(key => [key, rendererArtifact(expectedIdentity.runs[key], expectedIdentity.runs[key])])) as Record<RendererRunKey, any>
  rendererSame(rendererArtifact(expectedIdentity.artifact, expectedIdentity.artifact), report)
  rendererSame(report, deriveRustPackagedRendererCostEvidence(runs)); return true
}
