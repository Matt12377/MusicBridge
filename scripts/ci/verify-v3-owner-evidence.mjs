import { createHash } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { fileURLToPath } from 'node:url'

// 收据只证明一个有界观察窗口；任何单份收据都不能把完整 TASK-079 或 V3 升级为 ready。
const TASK = 'TASK-079'
const BASE_COMMIT = 'fac7363b4a6481591e207dda7cca77f0ae8d3cd4'
const EVIDENCE_ROOT = 'reports/runtime/task-079-v3-final-acceptance'
const TEMPLATE_PATH = 'project/V3_OWNER_EVIDENCE_TEMPLATE.json'
const MATRIX_SHA256 = '12f15170b25f578ba06d4def53060b58096fd57bf378d0e28f8ca2a7fe4ba944'
const EVIDENCE_KINDS = new Set(['real-output-measurement', 'real-input-observation', 'real-logic-observation', 'real-roon-observation', 'hardware-observation', 'owner-observed'])
const TECHNICAL_KINDS = new Set(['real-output-measurement', 'real-input-observation', 'real-logic-observation', 'real-roon-observation', 'hardware-observation'])
const SCOPE_IDS = new Set([
  ...Array.from({ length: 30 }, (_, index) => `MVP-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 11 }, (_, index) => `A-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 15 }, (_, index) => `B-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 11 }, (_, index) => `C-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 11 }, (_, index) => `D-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 15 }, (_, index) => `E-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, index) => `U-${String(index + 1).padStart(2, '0')}`),
])
const OUTPUT_SCOPES = new Set(Array.from({ length: 15 }, (_, index) => `B-${String(index + 1).padStart(2, '0')}`))
const NONPASS_REASONS = {
  'B-01': new Set(['asset-compilation-failed', 'operation-stopped', 'evidence-inconclusive']),
  'B-02': new Set(['gap-mismatch', 'operation-stopped', 'evidence-inconclusive']),
  'B-03': new Set(['silence-not-preserved', 'operation-stopped', 'evidence-inconclusive']),
  'B-04': new Set(['render-gap-invalid', 'operation-stopped', 'evidence-inconclusive']),
  'B-05': new Set(['format-unification-failed', 'operation-stopped', 'evidence-inconclusive']),
  'B-06': new Set(['fallback-detected', 'operation-stopped', 'evidence-inconclusive']),
  'B-07': new Set(['side-b-started', 'operation-stopped', 'evidence-inconclusive']),
  'B-08': new Set(['dat-flow-invalid', 'operation-stopped', 'evidence-inconclusive']),
  'B-09': new Set(['output-stop-failed', 'output-timeout', 'operation-stopped', 'evidence-inconclusive']),
  'B-10': new Set(['output-stop-failed', 'output-timeout', 'operation-stopped', 'evidence-inconclusive']),
  'B-11': new Set(['output-stop-failed', 'output-timeout', 'operation-stopped', 'evidence-inconclusive']),
  'B-12': new Set(['output-stop-failed', 'output-timeout', 'operation-stopped', 'evidence-inconclusive']),
  'B-13': new Set(['notification-detected', 'operation-stopped', 'evidence-inconclusive']),
  'B-14': new Set(['completion-layers-incomplete', 'operation-stopped', 'evidence-inconclusive']),
  'B-15': new Set(['configuration-not-certified', 'operation-stopped', 'evidence-inconclusive']),
}
const REAL_INPUT_NONPASS_REASONS = new Set(['source-unavailable', 'authorization-expired', 'hash-mismatch', 'source-modified', 'operation-stopped', 'evidence-inconclusive'])
const REAL_LOGIC_NONPASS_REASONS = new Set(['workspace-unavailable', 'export-unavailable', 'hash-mismatch', 'marker-mismatch', 'timeline-mismatch', 'operation-stopped', 'evidence-inconclusive'])
const REAL_LOGIC_OUTCOMES = new Map([
  ['MVP-08', 'workspace-generated'],
  ['MVP-09', 'exports-reimported'],
  ['MVP-10', 'prepared-master-frozen'],
  ['D-05', 'timeline-rebuilt'],
  ['D-06', 'accepted-variance'],
  ['D-07', 'requires-new-layout'],
  ['D-08', 'freeze-blocked'],
])
const REAL_ROON_FAILED_REASONS = new Set(['roon-unavailable', 'observer-mismatch', 'event-mismatch', 'mapping-mismatch'])
const REAL_ROON_CASES = new Map([
  ['MVP-02', { outcome: 'v2-regression-observed', connectionState: 'connected', operations: ['browse-library', 'observe-playback'] }],
  ['MVP-14', { outcome: 'inventory-recommendation-observed', connectionState: 'connected', operations: ['browse-library', 'select-track', 'read-inventory-recommendation'] }],
  ['MVP-22', { outcome: 'relationship-lineage-separated', connectionState: 'connected', operations: ['browse-library', 'inspect-relationship', 'inspect-recording-lineage'] }],
  ['A-02', { outcome: 'roon-file-mapping-confirmed', connectionState: 'connected', operations: ['browse-library', 'inspect-reference', 'confirm-file-mapping'] }],
  ['B-09', { outcome: 'external-takeover-interrupted', connectionState: 'connected', operations: ['observe-zone', 'observe-queue', 'observe-attempt-state', 'inject-external-roon-change'] }],
  ['U-01', { outcome: 'physical-roon-relationship-observed', connectionState: 'connected', operations: ['browse-library', 'inspect-relationship'] }],
  ['U-06', { outcome: 'multi-release-lineage-preserved', connectionState: 'connected', operations: ['browse-library', 'select-track', 'inspect-recording-lineage'] }],
  ['U-07', { outcome: 'preliminary-flow-bounded', connectionState: 'connected', operations: ['browse-library', 'select-track', 'read-inventory-recommendation', 'inspect-recording-gate'] }],
  ['U-10', { outcome: 'offline-history-preserved', connectionState: 'offline-observed', operations: ['observe-roon-offline', 'inspect-physical-history', 'inspect-attempt-state'] }],
])
const HARDWARE_FAILED_REASONS = new Set(['hardware-unavailable', 'configuration-mismatch', 'observation-mismatch', 'physical-state-mismatch'])
const HARDWARE_CASES = new Map([
  ['MVP-16', { outcome: 'formal-ab-flow-completed', observerPath: 'packages/bridge-core/src/recording/execution-coordinator.ts', operations: ['observe-device-output', 'observe-side-flow', 'observe-physical-completion', 'inspect-attempt-state'] }],
  ['MVP-18', { outcome: 'digital-replica-output-observed', observerPath: 'packages/bridge-core/src/recording/replica-coordinator.ts', operations: ['observe-device-output', 'observe-replica-flow', 'inspect-archive-binding'] }],
  ['U-05', { outcome: 'physical-inventory-transition-preserved', observerPath: 'packages/bridge-core/src/recording/archive-transactions.ts', operations: ['observe-physical-completion', 'inspect-inventory-transition', 'inspect-recovery-idempotency'] }],
  ['U-10', { outcome: 'interrupted-medium-state-preserved', observerPath: 'packages/bridge-core/src/recording/attempt-coordinator.ts', operations: ['observe-physical-stop', 'inspect-attempt-state', 'inspect-medium-state'] }],
])
const CONFIGURATION_KEYS = [
  'audioInterfaceAlias',
  'recorderAlias',
  'backendId',
  'backendVersion',
  'driverId',
  'driverVersion',
  'firmwareVersion',
  'interfaceUnitAlias',
  'recorderUnitAlias',
  'cableRouteId',
  'channelMap',
  'sampleRateHz',
  'channels',
  'sampleFormat',
  'bufferFrames',
  'clockMode',
  'outputLevelProfile',
  'converterId',
  'ditherMode',
  'physicalTargetAlias',
  'measurementDeviceAlias',
  'calibrationSha256',
  'measurementPlanSha256',
]
const ERROR_CODES = new Set([
  'ARGUMENTS',
  'SHAPE',
  'ROOT_REQUIRED',
  'IDENTITY',
  'TEMPLATE_STATE',
  'RECEIPT_STATE',
  'SCOPE',
  'CONFIGURATION',
  'ARTIFACT',
  'MEASUREMENT',
  'CASE_EVIDENCE',
  'OWNER_BOUNDARY',
  'INVALID_EVIDENCE',
])
const fail = code => { throw new Error(code) }
const check = (condition, code) => { if (!condition) fail(code) }
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const gitSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value)
const safeLabel = value => typeof value === 'string' && /^[a-z][a-z0-9-]{2,31}$/u.test(value)
const safeVersion = value => typeof value === 'string' && /^(?:v)?[0-9]+(?:\.[0-9]+){1,3}(?:-[a-z0-9.-]+)?$/u.test(value)
const canonicalTimestamp = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const safeArtifactPath = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) && !value.includes('//') && !value.includes('%') && !value.includes('..')
const exactKeys = (value, expected, code = 'SHAPE') => {
  check(value && typeof value === 'object' && !Array.isArray(value), code)
  check(expected.every(key => Object.hasOwn(value, key)), code)
  check(Object.keys(value).every(key => expected.includes(key)), code)
}

export function normalizeEvidenceError(error) {
  return error instanceof Error && ERROR_CODES.has(error.message) ? error.message : 'INVALID_EVIDENCE'
}

function safeFile(root, relativePath, { exactPath, prefix, limit = 128 * 1024 * 1024 } = {}) {
  check(typeof root === 'string' && path.isAbsolute(root), 'ROOT_REQUIRED')
  check(safeArtifactPath(relativePath) && !path.isAbsolute(relativePath), 'ARTIFACT')
  check(!relativePath.includes('\\') && !relativePath.split('/').some(part => !part || part === '.' || part === '..'), 'ARTIFACT')
  check((exactPath === undefined || relativePath === exactPath) && (prefix === undefined || relativePath.startsWith(`${prefix}/`)), 'ARTIFACT')
  const canonicalRoot = realpathSync(root)
  let current = canonicalRoot
  const componentIdentities = []
  for (const part of relativePath.split('/')) {
    current = path.join(current, part)
    let stat
    try { stat = lstatSync(current) } catch { fail('ARTIFACT') }
    check(!stat.isSymbolicLink(), 'ARTIFACT')
    componentIdentities.push({ path: current, dev: stat.dev, ino: stat.ino, nlink: stat.nlink })
  }
  let descriptor
  try { descriptor = openSync(current, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW) } catch { fail('ARTIFACT') }
  try {
    const stat = fstatSync(descriptor)
    check(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= limit, 'ARTIFACT')
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    check(after.dev === stat.dev && after.ino === stat.ino && after.size === stat.size && after.nlink === 1 && bytes.length === stat.size, 'ARTIFACT')
    for (const identity of componentIdentities) {
      let currentStat
      try { currentStat = lstatSync(identity.path) } catch { fail('ARTIFACT') }
      check(!currentStat.isSymbolicLink() && currentStat.dev === identity.dev && currentStat.ino === identity.ino && currentStat.nlink === identity.nlink, 'ARTIFACT')
    }
    check(realpathSync(current) === current, 'ARTIFACT')
    return bytes
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function validateConfiguration(configuration) {
  exactKeys(configuration, CONFIGURATION_KEYS, 'CONFIGURATION')
  for (const key of ['audioInterfaceAlias', 'recorderAlias', 'backendId', 'driverId', 'interfaceUnitAlias', 'recorderUnitAlias', 'cableRouteId', 'clockMode', 'outputLevelProfile', 'converterId', 'ditherMode', 'physicalTargetAlias', 'measurementDeviceAlias']) check(safeLabel(configuration[key]), 'CONFIGURATION')
  for (const key of ['backendVersion', 'driverVersion', 'firmwareVersion']) check(safeVersion(configuration[key]), 'CONFIGURATION')
  check([44100, 48000, 88200, 96000, 176400, 192000].includes(configuration.sampleRateHz), 'CONFIGURATION')
  check(Number.isInteger(configuration.channels) && configuration.channels >= 1 && configuration.channels <= 8, 'CONFIGURATION')
  check(Array.isArray(configuration.channelMap) && configuration.channelMap.length === configuration.channels && new Set(configuration.channelMap).size === configuration.channelMap.length && configuration.channelMap.every(safeLabel), 'CONFIGURATION')
  check(['pcm-s16', 'pcm-s24', 'pcm-s32', 'float32'].includes(configuration.sampleFormat), 'CONFIGURATION')
  check(Number.isInteger(configuration.bufferFrames) && configuration.bufferFrames >= 16 && configuration.bufferFrames <= 4096 && (configuration.bufferFrames & (configuration.bufferFrames - 1)) === 0, 'CONFIGURATION')
  check(sha256(configuration.calibrationSha256) && sha256(configuration.measurementPlanSha256), 'CONFIGURATION')
}

function configurationFingerprint(configuration) {
  const canonical = Object.fromEntries(CONFIGURATION_KEYS.map(key => [key, configuration[key]]))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function checkUntracked(root, relativePath) {
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd: root, stdio: 'ignore' })
  check(tracked.error === undefined && tracked.signal === null && tracked.status === 1, 'ARTIFACT')
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', relativePath], { cwd: root, stdio: 'ignore' })
  check(ignored.error === undefined && ignored.signal === null && ignored.status === 0, 'ARTIFACT')
}

function gitText(root, arguments_) {
  const result = spawnSync('git', arguments_, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  check(result.error === undefined && result.signal === null && result.status === 0, 'RECEIPT_STATE')
  return result.stdout.trim()
}

function gitBytes(root, arguments_) {
  const result = spawnSync('git', arguments_, { cwd: root, encoding: null, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 })
  check(result.error === undefined && result.signal === null && result.status === 0 && Buffer.isBuffer(result.stdout), 'RECEIPT_STATE')
  return result.stdout
}

export function validateRepositoryReceiptIdentity(root, receipt, controlledFiles = undefined) {
  check(realpathSync(gitText(root, ['rev-parse', '--show-toplevel'])) === realpathSync(root), 'RECEIPT_STATE')
  check(gitText(root, ['branch', '--show-current']) === 'codex/task-079-v3-final-acceptance', 'RECEIPT_STATE')
  check(gitText(root, ['rev-parse', 'HEAD']) === receipt.candidateCommit, 'RECEIPT_STATE')
  check(gitText(root, ['rev-parse', 'HEAD^{tree}']) === receipt.candidateTree, 'RECEIPT_STATE')
  check(gitText(root, ['status', '--porcelain=v1', '--untracked-files=all']) === '', 'RECEIPT_STATE')
  const matrixBytes = safeFile(root, 'project/V3_ACCEPTANCE.json', { exactPath: 'project/V3_ACCEPTANCE.json' })
  check(createHash('sha256').update(matrixBytes).digest('hex') === receipt.matrixSha256, 'RECEIPT_STATE')
  if (controlledFiles !== undefined) {
    check(Array.isArray(controlledFiles) && controlledFiles.length > 0 && controlledFiles.length <= 256, 'RECEIPT_STATE')
    const seen = new Set()
    for (const entry of controlledFiles) {
      exactKeys(entry, ['relativePath', 'sha256'], 'RECEIPT_STATE')
      check(safeArtifactPath(entry.relativePath) && !path.isAbsolute(entry.relativePath) && sha256(entry.sha256) && !seen.has(entry.relativePath), 'RECEIPT_STATE')
      seen.add(entry.relativePath)
      const committedBytes = gitBytes(root, ['show', `${receipt.candidateCommit}:${entry.relativePath}`])
      check(createHash('sha256').update(committedBytes).digest('hex') === entry.sha256, 'RECEIPT_STATE')
    }
  }
}

function readControlledFiles(root, envelope) {
  check(TECHNICAL_KINDS.has(envelope?.receipt?.kind), 'RECEIPT_STATE')
  const matches = envelope.receipt.artifacts.filter(artifact => artifact.role === 'candidate-manifest' && artifact.mediaType === 'application/json')
  check(matches.length === 1, 'RECEIPT_STATE')
  const bytes = safeFile(root, matches[0].relativePath, { exactPath: matches[0].relativePath })
  let manifest
  try { manifest = JSON.parse(bytes.toString('utf8')) } catch { fail('RECEIPT_STATE') }
  check(Array.isArray(manifest.controlledFiles), 'RECEIPT_STATE')
  return manifest.controlledFiles
}

export function sealReceipt(root, receiptId, receiptBytes) {
  const relativePath = `${EVIDENCE_ROOT}/receipts/${receiptId}.sealed.sha256`
  const expected = `${createHash('sha256').update(receiptBytes).digest('hex')}\n`
  const absolutePath = path.join(root, relativePath)
  let descriptor
  try {
    descriptor = openSync(absolutePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
    const bytes = Buffer.from(expected)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset)
      check(written > 0, 'RECEIPT_STATE')
      offset += written
    }
    fsyncSync(descriptor)
  } catch (error) {
    if (!(error instanceof Error) || error.code !== 'EEXIST') fail('RECEIPT_STATE')
    const existing = safeFile(root, relativePath, { exactPath: relativePath, limit: 128 })
    check(existing.toString('utf8') === expected, 'RECEIPT_STATE')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  checkUntracked(root, relativePath)
  const sealed = safeFile(root, relativePath, { exactPath: relativePath, limit: 128 })
  check(sealed.toString('utf8') === expected, 'RECEIPT_STATE')
}

function validateReceiptSeal(root, receiptId, receiptBytes, code = 'OWNER_BOUNDARY') {
  const relativePath = `${EVIDENCE_ROOT}/receipts/${receiptId}.sealed.sha256`
  let sealBytes
  try {
    checkUntracked(root, relativePath)
    sealBytes = safeFile(root, relativePath, { exactPath: relativePath, limit: 128 })
  } catch { fail(code) }
  const expected = `${createHash('sha256').update(receiptBytes).digest('hex')}\n`
  check(sealBytes.toString('utf8') === expected, code)
}

function validateArtifact(root, artifact, receiptId) {
  exactKeys(artifact, ['artifactId', 'role', 'relativePath', 'sha256', 'sizeBytes', 'mediaType'], 'ARTIFACT')
  check(safeLabel(artifact.artifactId), 'ARTIFACT')
  check(['independent-output-capture', 'external-observation', 'measurement-contract', 'candidate-manifest', 'authorization-seal', 'plan-seal', 'preflight-seal', 'event-log', 'completion-attestation', 'configuration-seal', 'case-evidence', 'environment-seal', 'hardware-subject-binding'].includes(artifact.role), 'ARTIFACT')
  check(sha256(artifact.sha256), 'ARTIFACT')
  check(Number.isInteger(artifact.sizeBytes) && artifact.sizeBytes > 0 && artifact.sizeBytes <= 16 * 1024 * 1024, 'ARTIFACT')
  check(['application/json', 'text/plain', 'text/csv'].includes(artifact.mediaType), 'ARTIFACT')
  check(/^[a-z0-9][a-z0-9._/-]*$/u.test(artifact.relativePath), 'ARTIFACT')
  if (receiptId !== null) check(artifact.relativePath.startsWith(`${EVIDENCE_ROOT}/receipts/${receiptId}/`), 'ARTIFACT')
  checkUntracked(root, artifact.relativePath)
  const bytes = safeFile(root, artifact.relativePath, { prefix: EVIDENCE_ROOT })
  check(bytes.length === artifact.sizeBytes && createHash('sha256').update(bytes).digest('hex') === artifact.sha256, 'ARTIFACT')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('ARTIFACT') }
  if (artifact.mediaType === 'application/json') {
    try { text = JSON.stringify(JSON.parse(text)) } catch { fail('ARTIFACT') }
  }
  const normalized = text.normalize('NFKC')
  check(!/(?:password|passphrase|secret|token|cookie|authorization|credential|api[_-]?key|session|bearer)/iu.test(normalized), 'ARTIFACT')
  check(!/(?:\/Users\/[^/\s]+|\/Volumes\/[^/\s]+|\/private\/[^\s]+|\/var\/folders\/[^\s]+|\/home\/[^/\s]+|[A-Za-z]:\\[^\s]+|(?:https?|file):\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?<![0-9])(?!(?:127)\.)[0-9]{1,3}(?:\.[0-9]{1,3}){3}(?![0-9])|coreaudio[-_ ]?uid|roon[-_ ]?(?:zone|session)[-_ ]?id)/iu.test(normalized), 'ARTIFACT')
  return bytes
}

function validateStats(stats) {
  exactKeys(stats, ['p50', 'p95', 'p99', 'max'], 'MEASUREMENT')
  const values = [stats.p50, stats.p95, stats.p99, stats.max]
  check(values.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0), 'MEASUREMENT')
  check(stats.p50 <= stats.p95 && stats.p95 <= stats.p99 && stats.p99 <= stats.max, 'MEASUREMENT')
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]
}

function expectedStats(samples, key) {
  const values = samples.map(sample => sample[key])
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Math.max(...values),
  }
}

function validateMeasurements(measurements, verdict, configuration, artifacts, artifactContents) {
  exactKeys(measurements, [
    'sampleCount',
    'failedCount',
    'timeoutCount',
    'clockRelation',
    'silenceCriterion',
    'measurementErrorMs',
    'samples',
    'detectMs',
    'engineCutoffMs',
    'backendTailMs',
    'totalMs',
  ], 'MEASUREMENT')
  check(Number.isInteger(measurements.sampleCount) && measurements.sampleCount > 0, 'MEASUREMENT')
  check(Number.isInteger(measurements.failedCount) && measurements.failedCount >= 0 && measurements.failedCount <= measurements.sampleCount, 'MEASUREMENT')
  check(Number.isInteger(measurements.timeoutCount) && measurements.timeoutCount >= 0 && measurements.timeoutCount <= measurements.sampleCount, 'MEASUREMENT')
  check(safeLabel(measurements.clockRelation) && safeLabel(measurements.silenceCriterion), 'MEASUREMENT')
  check(typeof measurements.measurementErrorMs === 'number' && Number.isFinite(measurements.measurementErrorMs) && measurements.measurementErrorMs >= 0, 'MEASUREMENT')
  const contracts = artifacts.filter(artifact => artifact.role === 'measurement-contract' && artifact.mediaType === 'application/json')
  const captures = artifacts.filter(artifact => artifact.role === 'independent-output-capture' && artifact.mediaType === 'application/json')
  check(contracts.length === 1 && captures.length >= 1, 'MEASUREMENT')
  let contract
  let rawSamples
  try {
    contract = JSON.parse(artifactContents.get(contracts[0].artifactId).toString('utf8'))
    rawSamples = JSON.parse(artifactContents.get(captures[0].artifactId).toString('utf8'))
  } catch { fail('MEASUREMENT') }
  exactKeys(contract, ['requiredSampleCount', 'maxMeasurementErrorMs', 'engineCutoffMaxMs', 'totalMaxMs', 'clockRelation', 'silenceCriterion'], 'MEASUREMENT')
  exactKeys(rawSamples, ['samples'], 'MEASUREMENT')
  check(Number.isInteger(contract.requiredSampleCount) && contract.requiredSampleCount > 0 && contract.requiredSampleCount <= 10_000, 'MEASUREMENT')
  check(typeof contract.maxMeasurementErrorMs === 'number' && contract.maxMeasurementErrorMs >= 0 && contract.maxMeasurementErrorMs <= 10, 'MEASUREMENT')
  check(contract.engineCutoffMaxMs === 100 && contract.totalMaxMs === 2000, 'MEASUREMENT')
  check(safeLabel(contract.clockRelation) && safeLabel(contract.silenceCriterion), 'MEASUREMENT')
  check(configuration.measurementPlanSha256 === contracts[0].sha256, 'MEASUREMENT')
  check(measurements.sampleCount === contract.requiredSampleCount && measurements.measurementErrorMs <= contract.maxMeasurementErrorMs, 'MEASUREMENT')
  check(measurements.clockRelation === contract.clockRelation && measurements.silenceCriterion === contract.silenceCriterion, 'MEASUREMENT')
  check(Array.isArray(measurements.samples) && measurements.samples.length === measurements.sampleCount && measurements.samples.length <= 10_000, 'MEASUREMENT')
  check(JSON.stringify(measurements.samples) === JSON.stringify(rawSamples.samples), 'MEASUREMENT')
  for (const sample of measurements.samples) {
    exactKeys(sample, ['state', 'detectMs', 'engineCutoffMs', 'backendTailMs', 'totalMs'], 'MEASUREMENT')
    check(['passed', 'failed', 'timed-out'].includes(sample.state), 'MEASUREMENT')
    for (const key of ['detectMs', 'engineCutoffMs', 'backendTailMs', 'totalMs']) check(typeof sample[key] === 'number' && Number.isFinite(sample[key]) && sample[key] >= 0, 'MEASUREMENT')
    check(Math.abs(sample.totalMs - sample.detectMs - sample.engineCutoffMs - sample.backendTailMs) <= measurements.measurementErrorMs, 'MEASUREMENT')
  }
  check(measurements.failedCount === measurements.samples.filter(sample => sample.state === 'failed').length, 'MEASUREMENT')
  check(measurements.timeoutCount === measurements.samples.filter(sample => sample.state === 'timed-out').length, 'MEASUREMENT')
  for (const key of ['detectMs', 'engineCutoffMs', 'backendTailMs', 'totalMs']) {
    validateStats(measurements[key])
    check(JSON.stringify(measurements[key]) === JSON.stringify(expectedStats(measurements.samples, key)), 'MEASUREMENT')
  }
  if (verdict === 'passed') {
    check(measurements.failedCount === 0 && measurements.timeoutCount === 0 && measurements.samples.every(sample => sample.state === 'passed'), 'MEASUREMENT')
    check(measurements.engineCutoffMs.max <= contract.engineCutoffMaxMs && measurements.totalMs.max <= contract.totalMaxMs, 'MEASUREMENT')
  }
  return measurements.failedCount === 0 && measurements.timeoutCount === 0 && measurements.samples.every(sample => sample.state === 'passed') && measurements.engineCutoffMs.max <= contract.engineCutoffMaxMs && measurements.totalMs.max <= contract.totalMaxMs
}

function validateOutputStop(caseEvidence, gateId, verdict) {
  const correlationKeys = gateId === 'B-09' ? ['correlationSha256', 'eventCorrelationSha256'] : []
  exactKeys(caseEvidence, ['type', ...correlationKeys, 'injectionKind', 'interrupted', 'outputEndpointMeasured', 'fallbackCount', 'replacementContentCount', 'automaticResumeCount', 'recoveredState'], 'CASE_EVIDENCE')
  const injectionKinds = {
    'B-09': ['roon-track-change', 'roon-zone-change', 'roon-output-change'],
    'B-10': ['device-removed', 'route-changed', 'sample-rate-changed'],
    'B-11': ['asset-read-failure', 'network-read-failure', 'underrun'],
    'B-12': ['engine-terminated', 'app-terminated'],
  }
  check(injectionKinds[gateId]?.includes(caseEvidence.injectionKind), 'CASE_EVIDENCE')
  check(caseEvidence.type === 'output-stop' && typeof caseEvidence.interrupted === 'boolean' && typeof caseEvidence.outputEndpointMeasured === 'boolean', 'CASE_EVIDENCE')
  if (gateId === 'B-09') check(sha256(caseEvidence.correlationSha256) && sha256(caseEvidence.eventCorrelationSha256), 'CASE_EVIDENCE')
  check([caseEvidence.fallbackCount, caseEvidence.replacementContentCount, caseEvidence.automaticResumeCount].every(value => Number.isInteger(value) && value >= 0), 'CASE_EVIDENCE')
  check(caseEvidence.recoveredState === null || caseEvidence.recoveredState === 'interrupted', 'CASE_EVIDENCE')
  const passed = caseEvidence.interrupted === true && caseEvidence.outputEndpointMeasured === true && [caseEvidence.fallbackCount, caseEvidence.replacementContentCount, caseEvidence.automaticResumeCount].every(value => value === 0) && (gateId === 'B-12' ? caseEvidence.recoveredState === 'interrupted' : caseEvidence.recoveredState === null)
  if (verdict === 'passed') check(passed, 'CASE_EVIDENCE')
  return passed
}

function validateConfigurationCertificate(root, certificateId, expectedSha256, expectedFingerprintSha256) {
  const relativePath = `${EVIDENCE_ROOT}/receipts/${certificateId}.certificate.json`
  const sealPath = `${EVIDENCE_ROOT}/receipts/${certificateId}.certificate.sealed.sha256`
  let bytes
  let sealBytes
  try {
    checkUntracked(root, relativePath)
    checkUntracked(root, sealPath)
    bytes = safeFile(root, relativePath, { exactPath: relativePath })
    sealBytes = safeFile(root, sealPath, { exactPath: sealPath, limit: 128 })
  } catch { fail('CASE_EVIDENCE') }
  const digest = createHash('sha256').update(bytes).digest('hex')
  check(digest === expectedSha256 && sealBytes.toString('utf8') === `${digest}\n`, 'CASE_EVIDENCE')
  let certificate
  try { certificate = JSON.parse(bytes.toString('utf8')) } catch { fail('CASE_EVIDENCE') }
  exactKeys(certificate, ['schemaVersion', 'kind', 'certificateId', 'scopeId', 'candidateCommit', 'candidateTree', 'matrixSha256', 'configurationFingerprintSha256', 'verdict'], 'CASE_EVIDENCE')
  check(certificate.schemaVersion === 1 && certificate.kind === 'configuration-certificate' && certificate.certificateId === certificateId && certificate.scopeId === 'B-15', 'CASE_EVIDENCE')
  check(gitSha(certificate.candidateCommit) && gitSha(certificate.candidateTree) && certificate.matrixSha256 === MATRIX_SHA256, 'CASE_EVIDENCE')
  check(certificate.configurationFingerprintSha256 === expectedFingerprintSha256 && certificate.verdict === 'passed', 'CASE_EVIDENCE')
  return certificate
}

function validateHardwareConfigurationCertificate(root, certificateId, expectedSha256, expectedFingerprintSha256, receipt, authorizationGrantedAt) {
  const relativePath = `${EVIDENCE_ROOT}/receipts/${certificateId}.hardware-certificate.json`
  const sealPath = `${EVIDENCE_ROOT}/receipts/${certificateId}.hardware-certificate.sealed.sha256`
  let bytes
  let sealBytes
  try {
    checkUntracked(root, relativePath)
    checkUntracked(root, sealPath)
    bytes = safeFile(root, relativePath, { exactPath: relativePath })
    sealBytes = safeFile(root, sealPath, { exactPath: sealPath, limit: 128 })
  } catch { fail('CASE_EVIDENCE') }
  const digest = createHash('sha256').update(bytes).digest('hex')
  check(digest === expectedSha256 && sealBytes.toString('utf8') === `${digest}\n`, 'CASE_EVIDENCE')
  let certificate
  try { certificate = JSON.parse(bytes.toString('utf8')) } catch { fail('CASE_EVIDENCE') }
  exactKeys(certificate, ['schemaVersion', 'kind', 'certificateId', 'scopeId', 'candidateCommit', 'candidateTree', 'candidateManifestSha256', 'matrixSha256', 'configurationFingerprintSha256', 'sourceReceiptId', 'sourceReceiptSha256', 'issuedAt', 'verdict'], 'CASE_EVIDENCE')
  check(certificate.schemaVersion === 1 && certificate.kind === 'hardware-configuration-certificate' && certificate.certificateId === certificateId && certificate.scopeId === 'B-15', 'CASE_EVIDENCE')
  check(certificate.candidateCommit === receipt.candidateCommit && certificate.candidateTree === receipt.candidateTree && certificate.matrixSha256 === receipt.matrixSha256, 'CASE_EVIDENCE')
  check(certificate.candidateManifestSha256 === receipt.candidateManifestSha256 && certificate.configurationFingerprintSha256 === expectedFingerprintSha256 && certificate.verdict === 'passed', 'CASE_EVIDENCE')
  check(safeLabel(certificate.sourceReceiptId) && sha256(certificate.sourceReceiptSha256) && canonicalTimestamp(certificate.issuedAt) && canonicalTimestamp(authorizationGrantedAt), 'CASE_EVIDENCE')
  const sourceRelativePath = `${EVIDENCE_ROOT}/receipts/${certificate.sourceReceiptId}.json`
  let sourceBytes
  try {
    checkUntracked(root, sourceRelativePath)
    sourceBytes = safeFile(root, sourceRelativePath, { exactPath: sourceRelativePath })
    validateReceiptSeal(root, certificate.sourceReceiptId, sourceBytes)
  } catch { fail('CASE_EVIDENCE') }
  check(createHash('sha256').update(sourceBytes).digest('hex') === certificate.sourceReceiptSha256, 'CASE_EVIDENCE')
  let sourceEnvelope
  try { sourceEnvelope = JSON.parse(sourceBytes.toString('utf8')) } catch { fail('CASE_EVIDENCE') }
  const source = sourceEnvelope?.receipt
  check(source?.receiptId === certificate.sourceReceiptId && source.kind === 'real-output-measurement' && JSON.stringify(source.scopeIds) === JSON.stringify(['B-15']), 'CASE_EVIDENCE')
  check(source.verdict === 'passed' && source.candidateCommit === certificate.candidateCommit && source.candidateTree === certificate.candidateTree, 'CASE_EVIDENCE')
  check(source.candidateManifestSha256 === certificate.candidateManifestSha256 && source.matrixSha256 === certificate.matrixSha256 && source.configurationFingerprintSha256 === certificate.configurationFingerprintSha256, 'CASE_EVIDENCE')
  let sourceResult
  try { sourceResult = validateV3EvidenceEnvelope(sourceEnvelope, { root }) } catch { fail('CASE_EVIDENCE') }
  check(sourceResult.verdict === 'passed', 'CASE_EVIDENCE')
  const times = [source.observedAt, certificate.issuedAt, authorizationGrantedAt].map(Date.parse)
  check(times.every(Number.isFinite) && times.every((value, index) => index === 0 || times[index - 1] <= value), 'CASE_EVIDENCE')
  return certificate
}

function validateCaseEvidence(receiptCaseEvidence, gateId, receiptId, configurationFingerprintSha256, verdict, artifacts, artifactContents, root) {
  const artifactById = new Map(artifacts.map(artifact => [artifact.artifactId, artifact]))
  const caseArtifacts = artifacts.filter(artifact => artifact.role === 'case-evidence' && artifact.mediaType === 'application/json')
  check(caseArtifacts.length === 1, 'CASE_EVIDENCE')
  let caseEvidence
  try { caseEvidence = JSON.parse(artifactContents.get(caseArtifacts[0].artifactId).toString('utf8')) } catch { fail('CASE_EVIDENCE') }
  check(JSON.stringify(caseEvidence) === JSON.stringify(receiptCaseEvidence), 'CASE_EVIDENCE')
  if (gateId === 'B-01') {
    exactKeys(caseEvidence, ['type', 'sourceCount', 'compiledBeforeFormalPlayback', 'runtimeTrackConversionCount', 'assetSha256', 'manifestSha256', 'frameManifestVerified'], 'CASE_EVIDENCE')
    check(caseEvidence.type === 'asset-manifest' && Number.isInteger(caseEvidence.sourceCount) && caseEvidence.sourceCount >= 0 && typeof caseEvidence.compiledBeforeFormalPlayback === 'boolean' && Number.isInteger(caseEvidence.runtimeTrackConversionCount) && caseEvidence.runtimeTrackConversionCount >= 0, 'CASE_EVIDENCE')
    check((caseEvidence.assetSha256 === null || sha256(caseEvidence.assetSha256)) && (caseEvidence.manifestSha256 === null || sha256(caseEvidence.manifestSha256)) && typeof caseEvidence.frameManifestVerified === 'boolean', 'CASE_EVIDENCE')
    const passed = caseEvidence.sourceCount === 3 && caseEvidence.compiledBeforeFormalPlayback === true && caseEvidence.runtimeTrackConversionCount === 0 && sha256(caseEvidence.assetSha256) && sha256(caseEvidence.manifestSha256) && caseEvidence.frameManifestVerified === true
    if (verdict === 'passed') check(passed, 'CASE_EVIDENCE')
    return passed
  }
  if (gateId === 'B-02') {
    exactKeys(caseEvidence, ['type', 'sampleRateHz', 'expectedGapFrames', 'observedGapFrames', 'finalAssetVerified'], 'CASE_EVIDENCE')
    check(caseEvidence.type === 'gap-frames' && Number.isInteger(caseEvidence.sampleRateHz) && caseEvidence.sampleRateHz > 0, 'CASE_EVIDENCE')
    check(Number.isInteger(caseEvidence.expectedGapFrames) && caseEvidence.expectedGapFrames >= 0, 'CASE_EVIDENCE')
    check(Array.isArray(caseEvidence.observedGapFrames) && caseEvidence.observedGapFrames.length <= 2 && caseEvidence.observedGapFrames.every(value => Number.isInteger(value) && value >= 0), 'CASE_EVIDENCE')
    check(typeof caseEvidence.finalAssetVerified === 'boolean', 'CASE_EVIDENCE')
    const passed = caseEvidence.expectedGapFrames === caseEvidence.sampleRateHz * 5 && caseEvidence.observedGapFrames.length === 2 && caseEvidence.observedGapFrames.every(value => value === caseEvidence.expectedGapFrames) && caseEvidence.finalAssetVerified === true
    if (verdict === 'passed') check(passed, 'CASE_EVIDENCE')
    return passed
  }
  if (gateId === 'B-03') {
    exactKeys(caseEvidence, ['type', 'leadingFramesBefore', 'leadingFramesAfter', 'trailingFramesBefore', 'trailingFramesAfter', 'preserved'], 'CASE_EVIDENCE')
    check(caseEvidence.type === 'source-silence' && ['leadingFramesBefore', 'leadingFramesAfter', 'trailingFramesBefore', 'trailingFramesAfter'].every(key => Number.isInteger(caseEvidence[key]) && caseEvidence[key] >= 0), 'CASE_EVIDENCE')
    check(typeof caseEvidence.preserved === 'boolean', 'CASE_EVIDENCE')
    const passed = caseEvidence.leadingFramesAfter === caseEvidence.leadingFramesBefore && caseEvidence.trailingFramesAfter === caseEvidence.trailingFramesBefore && caseEvidence.preserved === true
    if (verdict === 'passed') check(passed, 'CASE_EVIDENCE')
    return passed
  }
  if (gateId === 'B-04') {
    exactKeys(caseEvidence, ['type', 'renderConformant', 'additionalGapFrames', 'derivativeCreated', 'derivativeLineageSha256'], 'CASE_EVIDENCE')
    check(caseEvidence.type === 'prepared-render-gap' && typeof caseEvidence.renderConformant === 'boolean' && Number.isInteger(caseEvidence.additionalGapFrames) && caseEvidence.additionalGapFrames >= 0 && typeof caseEvidence.derivativeCreated === 'boolean', 'CASE_EVIDENCE')
    check(caseEvidence.derivativeLineageSha256 === null || sha256(caseEvidence.derivativeLineageSha256), 'CASE_EVIDENCE')
    const passed = caseEvidence.additionalGapFrames === 0 && (caseEvidence.renderConformant ? caseEvidence.derivativeCreated === false && caseEvidence.derivativeLineageSha256 === null : caseEvidence.derivativeCreated === true && sha256(caseEvidence.derivativeLineageSha256))
    if (verdict === 'passed') check(passed, 'CASE_EVIDENCE')
    return passed
  }
  if (gateId === 'B-05') {
    exactKeys(caseEvidence, ['type', 'inputFormatCount', 'finalSampleRateHz', 'finalChannels', 'runtimeFormatSwitchCount', 'lineageSha256'], 'CASE_EVIDENCE')
    check(caseEvidence.type === 'format-unification' && Number.isInteger(caseEvidence.inputFormatCount) && caseEvidence.inputFormatCount >= 2, 'CASE_EVIDENCE')
    check(Number.isInteger(caseEvidence.finalSampleRateHz) && caseEvidence.finalSampleRateHz > 0 && Number.isInteger(caseEvidence.finalChannels) && caseEvidence.finalChannels > 0, 'CASE_EVIDENCE')
    check(Number.isInteger(caseEvidence.runtimeFormatSwitchCount) && caseEvidence.runtimeFormatSwitchCount >= 0 && (caseEvidence.lineageSha256 === null || sha256(caseEvidence.lineageSha256)), 'CASE_EVIDENCE')
    const passed = caseEvidence.inputFormatCount >= 2 && caseEvidence.runtimeFormatSwitchCount === 0 && sha256(caseEvidence.lineageSha256)
    if (verdict === 'passed') check(passed, 'CASE_EVIDENCE')
    return passed
  }
  if (gateId === 'B-06') {
    exactKeys(caseEvidence, ['type', 'rejectedModes', 'sourceSwitchCount', 'backendSwitchCount'], 'CASE_EVIDENCE')
    check(caseEvidence.type === 'fallback-prohibition', 'CASE_EVIDENCE')
    check(Array.isArray(caseEvidence.rejectedModes) && caseEvidence.rejectedModes.every(safeLabel), 'CASE_EVIDENCE')
    check(Number.isInteger(caseEvidence.sourceSwitchCount) && caseEvidence.sourceSwitchCount >= 0 && Number.isInteger(caseEvidence.backendSwitchCount) && caseEvidence.backendSwitchCount >= 0, 'CASE_EVIDENCE')
    const passed = JSON.stringify(caseEvidence.rejectedModes) === JSON.stringify(['smart', 'online-fallback', 'shuffle', 'radio', 'ordinary-queue']) && caseEvidence.sourceSwitchCount === 0 && caseEvidence.backendSwitchCount === 0
    if (verdict === 'passed') check(passed, 'CASE_EVIDENCE')
    return passed
  }
  if (gateId === 'B-07') {
    exactKeys(caseEvidence, ['type', 'state', 'sideBStarted', 'sideBSubmittedFrames'], 'CASE_EVIDENCE')
    check(caseEvidence.type === 'side-a-end' && safeLabel(caseEvidence.state) && typeof caseEvidence.sideBStarted === 'boolean' && Number.isInteger(caseEvidence.sideBSubmittedFrames) && caseEvidence.sideBSubmittedFrames >= 0, 'CASE_EVIDENCE')
    const passed = caseEvidence.state === 'awaiting-side-flip' && caseEvidence.sideBStarted === false && caseEvidence.sideBSubmittedFrames === 0
    if (verdict === 'passed') check(passed, 'CASE_EVIDENCE')
    return passed
  }
  if (gateId === 'B-08') {
    exactKeys(caseEvidence, ['type', 'sideFlipFlowEntered', 'capacityMatched', 'automaticTrackIdClaimed'], 'CASE_EVIDENCE')
    check(caseEvidence.type === 'dat-continuous' && typeof caseEvidence.sideFlipFlowEntered === 'boolean' && typeof caseEvidence.capacityMatched === 'boolean' && typeof caseEvidence.automaticTrackIdClaimed === 'boolean', 'CASE_EVIDENCE')
    const passed = caseEvidence.sideFlipFlowEntered === false && caseEvidence.capacityMatched === true && caseEvidence.automaticTrackIdClaimed === false
    if (verdict === 'passed') check(passed, 'CASE_EVIDENCE')
    return passed
  }
  if (['B-09', 'B-10', 'B-11', 'B-12'].includes(gateId)) {
    const passed = validateOutputStop(caseEvidence, gateId, verdict)
    check(artifacts.some(artifact => artifact.role === 'independent-output-capture'), 'CASE_EVIDENCE')
    return passed
  }
  if (gateId === 'B-13') {
    exactKeys(caseEvidence, ['type', 'formalOutputNotificationDetected', 'promptRoute', 'captureArtifactId'], 'CASE_EVIDENCE')
    check(caseEvidence.type === 'notification-audio' && typeof caseEvidence.formalOutputNotificationDetected === 'boolean', 'CASE_EVIDENCE')
    check(['silent-ui', 'independent-confirmed'].includes(caseEvidence.promptRoute) && safeLabel(caseEvidence.captureArtifactId), 'CASE_EVIDENCE')
    check(artifactById.get(caseEvidence.captureArtifactId)?.role === 'independent-output-capture', 'CASE_EVIDENCE')
    let capture
    try { capture = JSON.parse(artifactContents.get(caseEvidence.captureArtifactId).toString('utf8')) } catch { fail('CASE_EVIDENCE') }
    exactKeys(capture, ['notificationDetected', 'promptRoute'], 'CASE_EVIDENCE')
    check(typeof capture.notificationDetected === 'boolean' && capture.notificationDetected === caseEvidence.formalOutputNotificationDetected && capture.promptRoute === caseEvidence.promptRoute, 'CASE_EVIDENCE')
    const passed = caseEvidence.formalOutputNotificationDetected === false
    if (verdict === 'passed') check(passed, 'CASE_EVIDENCE')
    return passed
  }
  if (gateId === 'B-14') {
    exactKeys(caseEvidence, ['type', 'sourceEofEvidenceId', 'backendDrainedEvidenceId', 'physicalCompletionEvidenceId', 'physicalStopMs', 'sourceEofAt', 'backendDrainedAt', 'physicalCompletedAt', 'completedAt', 'completedAfterAllLayers'], 'CASE_EVIDENCE')
    const evidenceIds = [caseEvidence.sourceEofEvidenceId, caseEvidence.backendDrainedEvidenceId, caseEvidence.physicalCompletionEvidenceId]
    check(caseEvidence.type === 'completion-layers' && evidenceIds.every(value => value === null || safeLabel(value)), 'CASE_EVIDENCE')
    const presentIds = evidenceIds.filter(value => value !== null)
    check(new Set(presentIds).size === presentIds.length, 'CASE_EVIDENCE')
    const layers = [
      { id: caseEvidence.sourceEofEvidenceId, role: 'event-log', event: 'source-eof', time: caseEvidence.sourceEofAt },
      { id: caseEvidence.backendDrainedEvidenceId, role: 'independent-output-capture', event: 'backend-drained', time: caseEvidence.backendDrainedAt },
      { id: caseEvidence.physicalCompletionEvidenceId, role: 'completion-attestation', event: 'physical-completed', time: caseEvidence.physicalCompletedAt, physical: true },
    ]
    for (const layer of layers) {
      if (layer.id === null) {
        check(layer.time === null && (!layer.physical || caseEvidence.physicalStopMs === null), 'CASE_EVIDENCE')
        continue
      }
      check(artifactById.get(layer.id)?.role === layer.role, 'CASE_EVIDENCE')
      let evidence
      try { evidence = JSON.parse(artifactContents.get(layer.id).toString('utf8')) } catch { fail('CASE_EVIDENCE') }
      exactKeys(evidence, layer.physical ? ['event', 'observedAt', 'physicalStopMs'] : ['event', 'observedAt'], 'CASE_EVIDENCE')
      check(evidence.event === layer.event && evidence.observedAt === layer.time, 'CASE_EVIDENCE')
      if (layer.physical) check(evidence.physicalStopMs === caseEvidence.physicalStopMs, 'CASE_EVIDENCE')
    }
    check(caseEvidence.physicalStopMs === null || (typeof caseEvidence.physicalStopMs === 'number' && Number.isFinite(caseEvidence.physicalStopMs) && caseEvidence.physicalStopMs >= 0), 'CASE_EVIDENCE')
    const rawTimes = ['sourceEofAt', 'backendDrainedAt', 'physicalCompletedAt', 'completedAt'].map(key => caseEvidence[key])
    check(rawTimes.every(value => value === null || canonicalTimestamp(value)), 'CASE_EVIDENCE')
    check(typeof caseEvidence.completedAfterAllLayers === 'boolean', 'CASE_EVIDENCE')
    const times = rawTimes.map(value => value === null ? Number.NaN : Date.parse(value))
    const passed = presentIds.length === 3 && times.every(Number.isFinite) && times[3] >= Math.max(...times.slice(0, 3)) && caseEvidence.completedAfterAllLayers === true
    if (verdict === 'passed') check(passed, 'CASE_EVIDENCE')
    return passed
  }
  if (gateId === 'B-15') {
    exactKeys(caseEvidence, ['type', 'priorCertificateId', 'priorCertificateSha256', 'previousConfigurationFingerprintSha256', 'currentConfigurationFingerprintSha256', 'oldCertificateApplied', 'changedKeys', 'certificateState', 'recertificationReceiptId'], 'CASE_EVIDENCE')
    check(safeLabel(caseEvidence.priorCertificateId) && sha256(caseEvidence.priorCertificateSha256) && safeLabel(caseEvidence.recertificationReceiptId), 'CASE_EVIDENCE')
    check(caseEvidence.type === 'configuration-certification' && sha256(caseEvidence.previousConfigurationFingerprintSha256) && sha256(caseEvidence.currentConfigurationFingerprintSha256), 'CASE_EVIDENCE')
    check(caseEvidence.previousConfigurationFingerprintSha256 !== caseEvidence.currentConfigurationFingerprintSha256, 'CASE_EVIDENCE')
    check(caseEvidence.currentConfigurationFingerprintSha256 === configurationFingerprintSha256 && typeof caseEvidence.oldCertificateApplied === 'boolean', 'CASE_EVIDENCE')
    check(caseEvidence.recertificationReceiptId === receiptId, 'CASE_EVIDENCE')
    validateConfigurationCertificate(root, caseEvidence.priorCertificateId, caseEvidence.priorCertificateSha256, caseEvidence.previousConfigurationFingerprintSha256)
    check(Array.isArray(caseEvidence.changedKeys) && caseEvidence.changedKeys.length > 0 && new Set(caseEvidence.changedKeys).size === caseEvidence.changedKeys.length && caseEvidence.changedKeys.every(key => CONFIGURATION_KEYS.includes(key)), 'CASE_EVIDENCE')
    check(['recertified', 'not-certified'].includes(caseEvidence.certificateState), 'CASE_EVIDENCE')
    const passed = caseEvidence.oldCertificateApplied === false && caseEvidence.certificateState === 'recertified'
    if (verdict === 'passed') check(passed, 'CASE_EVIDENCE')
    else check(caseEvidence.certificateState === 'not-certified', 'CASE_EVIDENCE')
    return passed
  }
  fail('CASE_EVIDENCE')
}

function parseSingleArtifact(artifacts, artifactContents, role) {
  const matches = artifacts.filter(artifact => artifact.role === role && artifact.mediaType === 'application/json')
  check(matches.length === 1, 'RECEIPT_STATE')
  let value
  try { value = JSON.parse(artifactContents.get(matches[0].artifactId).toString('utf8')) } catch { fail('RECEIPT_STATE') }
  return { artifact: matches[0], value }
}

function validateTechnicalSeals(receipt, artifacts, artifactContents) {
  const scopeId = receipt.scopeIds[0]
  const correlationKeys = scopeId === 'B-09' ? ['correlationSha256'] : []
  const measurementContract = parseSingleArtifact(artifacts, artifactContents, 'measurement-contract')
  const environment = parseSingleArtifact(artifacts, artifactContents, 'environment-seal')
  exactKeys(environment.value, ['runId', 'osFamily', 'architecture', 'backendId', 'measurementDeviceAlias', 'clockRelation'], 'RECEIPT_STATE')
  check(environment.value.runId === receipt.receiptId && environment.value.osFamily === 'macos' && ['arm64', 'x86-64'].includes(environment.value.architecture), 'RECEIPT_STATE')
  check(environment.value.backendId === receipt.configuration.backendId && environment.value.measurementDeviceAlias === receipt.configuration.measurementDeviceAlias, 'RECEIPT_STATE')
  check(environment.value.clockRelation === receipt.measurements?.clockRelation || environment.value.clockRelation === measurementContract.value.clockRelation, 'RECEIPT_STATE')
  check(environment.artifact.sha256 === receipt.environmentFingerprint, 'RECEIPT_STATE')
  const authorization = parseSingleArtifact(artifacts, artifactContents, 'authorization-seal')
  exactKeys(authorization.value, ['scopeId', 'runId', 'candidateCommit', 'candidateTree', 'candidateManifestSha256', ...correlationKeys, 'configurationFingerprintSha256', 'measurementContractSha256', 'allowedOperations', 'allowedInjectionKinds', 'allowedDataClasses', 'grantedAt', 'expiresAt'], 'RECEIPT_STATE')
  check(authorization.value.scopeId === scopeId && authorization.value.runId === receipt.receiptId && authorization.value.candidateCommit === receipt.candidateCommit && authorization.value.candidateTree === receipt.candidateTree, 'RECEIPT_STATE')
  check(authorization.value.candidateManifestSha256 === receipt.candidateManifestSha256 && authorization.value.configurationFingerprintSha256 === receipt.configurationFingerprintSha256 && authorization.value.measurementContractSha256 === measurementContract.artifact.sha256, 'RECEIPT_STATE')
  if (scopeId === 'B-09') check(sha256(authorization.value.correlationSha256) && authorization.value.correlationSha256 === receipt.caseEvidence.correlationSha256, 'RECEIPT_STATE')
  for (const key of ['allowedOperations', 'allowedInjectionKinds', 'allowedDataClasses']) check(Array.isArray(authorization.value[key]) && new Set(authorization.value[key]).size === authorization.value[key].length && authorization.value[key].every(safeLabel), 'RECEIPT_STATE')
  check(authorization.value.allowedOperations.length > 0 && authorization.value.allowedDataClasses.length > 0, 'RECEIPT_STATE')
  check(canonicalTimestamp(authorization.value.grantedAt) && canonicalTimestamp(authorization.value.expiresAt), 'RECEIPT_STATE')
  if (['B-09', 'B-10', 'B-11', 'B-12'].includes(scopeId)) check(authorization.value.allowedInjectionKinds.includes(receipt.caseEvidence.injectionKind), 'RECEIPT_STATE')
  else check(authorization.value.allowedInjectionKinds.length === 0, 'RECEIPT_STATE')
  check(authorization.artifact.sha256 === receipt.authorizationSha256, 'RECEIPT_STATE')

  const plan = parseSingleArtifact(artifacts, artifactContents, 'plan-seal')
  exactKeys(plan.value, ['scopeId', 'runId', 'candidateCommit', 'candidateTree', 'candidateManifestSha256', ...correlationKeys, 'configurationFingerprintSha256', 'measurementContractSha256', 'grantSha256', 'frozenAt'], 'RECEIPT_STATE')
  check(plan.value.scopeId === scopeId && plan.value.runId === receipt.receiptId && plan.value.candidateCommit === receipt.candidateCommit && plan.value.candidateTree === receipt.candidateTree && plan.value.candidateManifestSha256 === receipt.candidateManifestSha256 && plan.value.configurationFingerprintSha256 === receipt.configurationFingerprintSha256, 'RECEIPT_STATE')
  check(plan.value.measurementContractSha256 === measurementContract.artifact.sha256 && plan.value.grantSha256 === receipt.authorizationSha256, 'RECEIPT_STATE')
  if (scopeId === 'B-09') check(plan.value.correlationSha256 === receipt.caseEvidence.correlationSha256, 'RECEIPT_STATE')
  check(canonicalTimestamp(plan.value.frozenAt), 'RECEIPT_STATE')
  check(plan.artifact.sha256 === receipt.planSha256, 'RECEIPT_STATE')

  const preflight = parseSingleArtifact(artifacts, artifactContents, 'preflight-seal')
  exactKeys(preflight.value, ['scopeId', 'runId', 'candidateCommit', 'candidateTree', 'candidateManifestSha256', ...correlationKeys, 'configurationFingerprintSha256', 'measurementContractSha256', 'grantSha256', 'planSha256', 'observedAt', 'passed'], 'RECEIPT_STATE')
  check(preflight.value.scopeId === scopeId && preflight.value.runId === receipt.receiptId && preflight.value.candidateCommit === receipt.candidateCommit && preflight.value.candidateTree === receipt.candidateTree && preflight.value.candidateManifestSha256 === receipt.candidateManifestSha256, 'RECEIPT_STATE')
  check(preflight.value.configurationFingerprintSha256 === receipt.configurationFingerprintSha256 && preflight.value.measurementContractSha256 === measurementContract.artifact.sha256 && preflight.value.grantSha256 === receipt.authorizationSha256 && preflight.value.planSha256 === receipt.planSha256 && preflight.value.passed === true, 'RECEIPT_STATE')
  if (scopeId === 'B-09') check(preflight.value.correlationSha256 === receipt.caseEvidence.correlationSha256, 'RECEIPT_STATE')
  check(canonicalTimestamp(preflight.value.observedAt), 'RECEIPT_STATE')
  check(preflight.artifact.sha256 === receipt.preflightSha256, 'RECEIPT_STATE')

  const configurationSeal = parseSingleArtifact(artifacts, artifactContents, 'configuration-seal')
  check(configurationSeal.artifact.sha256 === receipt.configurationFingerprintSha256, 'CONFIGURATION')
  check(JSON.stringify(configurationSeal.value) === JSON.stringify(receipt.configuration), 'CONFIGURATION')

  const candidateManifest = parseSingleArtifact(artifacts, artifactContents, 'candidate-manifest')
  exactKeys(candidateManifest.value, ['candidateCommit', 'candidateTree', 'controlledFiles', 'controlledFilesSha256'], 'RECEIPT_STATE')
  check(candidateManifest.value.candidateCommit === receipt.candidateCommit && candidateManifest.value.candidateTree === receipt.candidateTree, 'RECEIPT_STATE')
  check(Array.isArray(candidateManifest.value.controlledFiles) && candidateManifest.value.controlledFiles.length > 0 && candidateManifest.value.controlledFiles.length <= 256, 'RECEIPT_STATE')
  const controlledPaths = new Set()
  for (const entry of candidateManifest.value.controlledFiles) {
    exactKeys(entry, ['relativePath', 'sha256'], 'RECEIPT_STATE')
    check(safeArtifactPath(entry.relativePath) && !path.isAbsolute(entry.relativePath) && sha256(entry.sha256) && !controlledPaths.has(entry.relativePath), 'RECEIPT_STATE')
    controlledPaths.add(entry.relativePath)
  }
  check(candidateManifest.value.controlledFilesSha256 === createHash('sha256').update(JSON.stringify(candidateManifest.value.controlledFiles)).digest('hex'), 'RECEIPT_STATE')
  check(candidateManifest.artifact.sha256 === receipt.candidateManifestSha256, 'RECEIPT_STATE')

  const times = [authorization.value.grantedAt, plan.value.frozenAt, preflight.value.observedAt, receipt.observedAt, authorization.value.expiresAt].map(Date.parse)
  check(times.every(Number.isFinite) && times.every((value, index) => index === 0 || times[index - 1] <= value), 'RECEIPT_STATE')
}

function validateExternalSeals(receipt, artifacts, artifactContents, criterionSha256, { externalKind, environmentAliasKey, allowedOperations, allowedDataClasses, dependencyReceiptsSha256 = null }) {
  const scopeId = receipt.scopeIds[0]
  const dependencyKeys = dependencyReceiptsSha256 === null ? [] : ['dependencyReceiptsSha256']
  const environment = parseSingleArtifact(artifacts, artifactContents, 'environment-seal')
  exactKeys(environment.value, ['runId', 'osFamily', 'architecture', 'externalKind', environmentAliasKey], 'RECEIPT_STATE')
  check(environment.value.runId === receipt.receiptId && environment.value.osFamily === 'macos' && ['arm64', 'x64'].includes(environment.value.architecture), 'RECEIPT_STATE')
  check(environment.value.externalKind === externalKind && safeLabel(environment.value[environmentAliasKey]) && environment.artifact.sha256 === receipt.environmentFingerprint, 'RECEIPT_STATE')

  const candidateManifest = parseSingleArtifact(artifacts, artifactContents, 'candidate-manifest')
  exactKeys(candidateManifest.value, ['candidateCommit', 'candidateTree', 'controlledFiles', 'controlledFilesSha256'], 'RECEIPT_STATE')
  check(candidateManifest.value.candidateCommit === receipt.candidateCommit && candidateManifest.value.candidateTree === receipt.candidateTree, 'RECEIPT_STATE')
  check(Array.isArray(candidateManifest.value.controlledFiles) && candidateManifest.value.controlledFiles.length > 0 && candidateManifest.value.controlledFiles.length <= 256, 'RECEIPT_STATE')
  const controlledPaths = new Set()
  for (const entry of candidateManifest.value.controlledFiles) {
    exactKeys(entry, ['relativePath', 'sha256'], 'RECEIPT_STATE')
    check(safeArtifactPath(entry.relativePath) && !path.isAbsolute(entry.relativePath) && sha256(entry.sha256) && !controlledPaths.has(entry.relativePath), 'RECEIPT_STATE')
    controlledPaths.add(entry.relativePath)
  }
  check(candidateManifest.value.controlledFilesSha256 === createHash('sha256').update(JSON.stringify(candidateManifest.value.controlledFiles)).digest('hex'), 'RECEIPT_STATE')
  check(candidateManifest.artifact.sha256 === receipt.candidateManifestSha256, 'RECEIPT_STATE')

  const authorization = parseSingleArtifact(artifacts, artifactContents, 'authorization-seal')
  exactKeys(authorization.value, ['scopeId', 'runId', 'candidateCommit', 'candidateTree', 'candidateManifestSha256', 'externalKind', 'correlationSha256', 'criterionSha256', ...dependencyKeys, 'allowedOperations', 'allowedDataClasses', 'grantedAt', 'expiresAt'], 'RECEIPT_STATE')
  check(authorization.value.scopeId === scopeId && authorization.value.runId === receipt.receiptId && authorization.value.candidateCommit === receipt.candidateCommit && authorization.value.candidateTree === receipt.candidateTree, 'RECEIPT_STATE')
  check(authorization.value.candidateManifestSha256 === receipt.candidateManifestSha256 && authorization.value.externalKind === externalKind && authorization.value.correlationSha256 === receipt.caseEvidence.correlationSha256 && authorization.value.criterionSha256 === criterionSha256, 'RECEIPT_STATE')
  check(sha256(authorization.value.correlationSha256), 'RECEIPT_STATE')
  if (dependencyReceiptsSha256 !== null) check(sha256(dependencyReceiptsSha256) && authorization.value.dependencyReceiptsSha256 === dependencyReceiptsSha256, 'RECEIPT_STATE')
  check(JSON.stringify(authorization.value.allowedOperations) === JSON.stringify(allowedOperations) && JSON.stringify(authorization.value.allowedDataClasses) === JSON.stringify(allowedDataClasses), 'RECEIPT_STATE')
  check(canonicalTimestamp(authorization.value.grantedAt) && canonicalTimestamp(authorization.value.expiresAt) && authorization.artifact.sha256 === receipt.authorizationSha256, 'RECEIPT_STATE')

  const plan = parseSingleArtifact(artifacts, artifactContents, 'plan-seal')
  exactKeys(plan.value, ['scopeId', 'runId', 'candidateCommit', 'candidateTree', 'candidateManifestSha256', 'externalKind', 'correlationSha256', 'criterionSha256', ...dependencyKeys, 'grantSha256', 'frozenAt'], 'RECEIPT_STATE')
  check(plan.value.scopeId === scopeId && plan.value.runId === receipt.receiptId && plan.value.candidateCommit === receipt.candidateCommit && plan.value.candidateTree === receipt.candidateTree, 'RECEIPT_STATE')
  check(plan.value.candidateManifestSha256 === receipt.candidateManifestSha256 && plan.value.externalKind === externalKind && plan.value.correlationSha256 === receipt.caseEvidence.correlationSha256 && plan.value.criterionSha256 === criterionSha256 && plan.value.grantSha256 === receipt.authorizationSha256, 'RECEIPT_STATE')
  if (dependencyReceiptsSha256 !== null) check(plan.value.dependencyReceiptsSha256 === dependencyReceiptsSha256, 'RECEIPT_STATE')
  check(canonicalTimestamp(plan.value.frozenAt) && plan.artifact.sha256 === receipt.planSha256, 'RECEIPT_STATE')

  const preflight = parseSingleArtifact(artifacts, artifactContents, 'preflight-seal')
  exactKeys(preflight.value, ['scopeId', 'runId', 'candidateCommit', 'candidateTree', 'candidateManifestSha256', 'externalKind', 'correlationSha256', 'criterionSha256', ...dependencyKeys, 'grantSha256', 'planSha256', 'observedAt', 'passed'], 'RECEIPT_STATE')
  check(preflight.value.scopeId === scopeId && preflight.value.runId === receipt.receiptId && preflight.value.candidateCommit === receipt.candidateCommit && preflight.value.candidateTree === receipt.candidateTree, 'RECEIPT_STATE')
  check(preflight.value.candidateManifestSha256 === receipt.candidateManifestSha256 && preflight.value.externalKind === externalKind && preflight.value.correlationSha256 === receipt.caseEvidence.correlationSha256 && preflight.value.criterionSha256 === criterionSha256, 'RECEIPT_STATE')
  check(preflight.value.grantSha256 === receipt.authorizationSha256 && preflight.value.planSha256 === receipt.planSha256 && preflight.value.passed === true, 'RECEIPT_STATE')
  if (dependencyReceiptsSha256 !== null) check(preflight.value.dependencyReceiptsSha256 === dependencyReceiptsSha256, 'RECEIPT_STATE')
  check(canonicalTimestamp(preflight.value.observedAt) && preflight.artifact.sha256 === receipt.preflightSha256, 'RECEIPT_STATE')

  const times = [authorization.value.grantedAt, plan.value.frozenAt, preflight.value.observedAt, receipt.observedAt, authorization.value.expiresAt].map(Date.parse)
  check(times.every(Number.isFinite) && times.every((value, index) => index === 0 || times[index - 1] <= value), 'RECEIPT_STATE')
}

function validateRealInputCase(receipt, artifacts, artifactContents, entry) {
  const criterionSha256 = createHash('sha256').update(JSON.stringify(entry.source)).digest('hex')
  const caseArtifact = parseSingleArtifact(artifacts, artifactContents, 'case-evidence')
  check(JSON.stringify(caseArtifact.value) === JSON.stringify(receipt.caseEvidence), 'CASE_EVIDENCE')
  exactKeys(receipt.caseEvidence, ['type', 'externalKind', 'correlationSha256', 'criterionSha256', 'sourceCount', 'authorizedRead', 'contentHashesVerified', 'originalBytesUnchanged', 'criterionSatisfied', 'observationArtifactIds'], 'CASE_EVIDENCE')
  const evidence = receipt.caseEvidence
  check(evidence.type === 'real-input' && evidence.externalKind === 'real-input' && sha256(evidence.correlationSha256) && evidence.criterionSha256 === criterionSha256, 'CASE_EVIDENCE')
  check(Number.isInteger(evidence.sourceCount) && evidence.sourceCount >= 1 && evidence.sourceCount <= 1000, 'CASE_EVIDENCE')
  check(Array.isArray(evidence.observationArtifactIds) && evidence.observationArtifactIds.length === 1 && new Set(evidence.observationArtifactIds).size === 1, 'CASE_EVIDENCE')
  for (const artifactId of evidence.observationArtifactIds) {
    const artifact = artifacts.find(value => value.artifactId === artifactId)
    check(artifact?.role === 'external-observation' && artifactContents.has(artifactId), 'CASE_EVIDENCE')
    let observation
    try { observation = JSON.parse(artifactContents.get(artifactId).toString('utf8')) } catch { fail('CASE_EVIDENCE') }
    exactKeys(observation, ['sourceAliases', 'sourceSha256s'], 'CASE_EVIDENCE')
    check(Array.isArray(observation.sourceAliases) && Array.isArray(observation.sourceSha256s) && observation.sourceAliases.length === observation.sourceSha256s.length, 'CASE_EVIDENCE')
    check(observation.sourceAliases.length === evidence.sourceCount && new Set(observation.sourceAliases).size === observation.sourceAliases.length && observation.sourceAliases.every(safeLabel), 'CASE_EVIDENCE')
    check(new Set(observation.sourceSha256s).size === observation.sourceSha256s.length && observation.sourceSha256s.every(sha256), 'CASE_EVIDENCE')
  }
  const passed = evidence.authorizedRead === true && evidence.contentHashesVerified === true && evidence.originalBytesUnchanged === true && evidence.criterionSatisfied === true
  check(receipt.verdict === 'passed' ? passed : !passed, 'CASE_EVIDENCE')
  return criterionSha256
}

function validateRealLogicCase(receipt, artifacts, artifactContents, entry) {
  const criterionSha256 = createHash('sha256').update(JSON.stringify(entry.source)).digest('hex')
  const caseArtifact = parseSingleArtifact(artifacts, artifactContents, 'case-evidence')
  check(JSON.stringify(caseArtifact.value) === JSON.stringify(receipt.caseEvidence), 'CASE_EVIDENCE')
  exactKeys(receipt.caseEvidence, ['type', 'externalKind', 'correlationSha256', 'criterionSha256', 'workspaceOpened', 'exportCount', 'exportHashesVerified', 'markerEvidenceVerified', 'timelineEvidenceVerified', 'observedOutcome', 'criterionSatisfied', 'observationArtifactIds'], 'CASE_EVIDENCE')
  const evidence = receipt.caseEvidence
  const expectedOutcome = REAL_LOGIC_OUTCOMES.get(receipt.scopeIds[0])
  check(expectedOutcome !== undefined && evidence.type === 'real-logic' && evidence.externalKind === 'real-logic' && sha256(evidence.correlationSha256) && evidence.criterionSha256 === criterionSha256, 'CASE_EVIDENCE')
  check(typeof evidence.workspaceOpened === 'boolean' && Number.isInteger(evidence.exportCount) && evidence.exportCount >= 1 && evidence.exportCount <= 32, 'CASE_EVIDENCE')
  check(typeof evidence.exportHashesVerified === 'boolean' && typeof evidence.markerEvidenceVerified === 'boolean' && typeof evidence.timelineEvidenceVerified === 'boolean' && typeof evidence.criterionSatisfied === 'boolean', 'CASE_EVIDENCE')
  check(evidence.observedOutcome === expectedOutcome, 'CASE_EVIDENCE')
  check(Array.isArray(evidence.observationArtifactIds) && evidence.observationArtifactIds.length === 1 && new Set(evidence.observationArtifactIds).size === 1, 'CASE_EVIDENCE')
  const artifactId = evidence.observationArtifactIds[0]
  const artifact = artifacts.find(value => value.artifactId === artifactId)
  check(artifact?.role === 'external-observation' && artifactContents.has(artifactId), 'CASE_EVIDENCE')
  let observation
  try { observation = JSON.parse(artifactContents.get(artifactId).toString('utf8')) } catch { fail('CASE_EVIDENCE') }
  exactKeys(observation, ['workspaceAlias', 'projectSha256', 'exports'], 'CASE_EVIDENCE')
  check(safeLabel(observation.workspaceAlias) && sha256(observation.projectSha256), 'CASE_EVIDENCE')
  const environment = parseSingleArtifact(artifacts, artifactContents, 'environment-seal')
  check(environment.value?.logicWorkspaceAlias === observation.workspaceAlias, 'CASE_EVIDENCE')
  check(Array.isArray(observation.exports) && observation.exports.length === evidence.exportCount, 'CASE_EVIDENCE')
  const aliases = new Set()
  const hashes = new Set()
  for (const item of observation.exports) {
    exactKeys(item, ['exportAlias', 'sha256', 'markerCount', 'timelineSha256'], 'CASE_EVIDENCE')
    check(safeLabel(item.exportAlias) && !aliases.has(item.exportAlias) && sha256(item.sha256) && !hashes.has(item.sha256), 'CASE_EVIDENCE')
    check(Number.isInteger(item.markerCount) && item.markerCount >= 1 && item.markerCount <= 10000 && sha256(item.timelineSha256), 'CASE_EVIDENCE')
    aliases.add(item.exportAlias)
    hashes.add(item.sha256)
  }
  const passed = evidence.workspaceOpened === true && evidence.exportHashesVerified === true && evidence.markerEvidenceVerified === true && evidence.timelineEvidenceVerified === true && evidence.criterionSatisfied === true
  check(receipt.verdict === 'passed' ? passed : !passed, 'CASE_EVIDENCE')
  return criterionSha256
}

function validateRealRoonFacts(scopeId, facts) {
  if (scopeId === 'MVP-02') {
    exactKeys(facts, ['requiredPageCount', 'openedPageCount', 'playbackStarted', 'playbackContinued', 'playbackStateBeforeSha256', 'playbackStateAfterSha256'], 'CASE_EVIDENCE')
    check(Number.isInteger(facts.requiredPageCount) && Number.isInteger(facts.openedPageCount) && facts.requiredPageCount >= 1 && facts.openedPageCount >= 0, 'CASE_EVIDENCE')
    check(typeof facts.playbackStarted === 'boolean' && typeof facts.playbackContinued === 'boolean' && sha256(facts.playbackStateBeforeSha256) && sha256(facts.playbackStateAfterSha256), 'CASE_EVIDENCE')
    return facts.openedPageCount === facts.requiredPageCount && facts.playbackStarted === true && facts.playbackContinued === true && facts.playbackStateBeforeSha256 === facts.playbackStateAfterSha256
  }
  if (scopeId === 'MVP-14') {
    exactKeys(facts, ['selectionSha256', 'recommendationSelectionSha256', 'reasonShown', 'availableCountShown', 'sideFitShown', 'revalidatedBeforeFormalRecording'], 'CASE_EVIDENCE')
    check(sha256(facts.selectionSha256) && sha256(facts.recommendationSelectionSha256), 'CASE_EVIDENCE')
    check(['reasonShown', 'availableCountShown', 'sideFitShown', 'revalidatedBeforeFormalRecording'].every(key => typeof facts[key] === 'boolean'), 'CASE_EVIDENCE')
    return facts.selectionSha256 === facts.recommendationSelectionSha256 && facts.reasonShown === true && facts.availableCountShown === true && facts.sideFitShown === true && facts.revalidatedBeforeFormalRecording === true
  }
  if (scopeId === 'MVP-22') {
    exactKeys(facts, ['physicalReleaseAlias', 'digitalReleaseAlias', 'releaseRelationType', 'recordedLineageType', 'recordedTrackCount', 'tracedTrackCount'], 'CASE_EVIDENCE')
    check(safeLabel(facts.physicalReleaseAlias) && safeLabel(facts.digitalReleaseAlias) && facts.physicalReleaseAlias !== facts.digitalReleaseAlias, 'CASE_EVIDENCE')
    check(['release-link', 'not-observed'].includes(facts.releaseRelationType) && ['recorded-track-lineage', 'not-observed'].includes(facts.recordedLineageType), 'CASE_EVIDENCE')
    check(Number.isInteger(facts.recordedTrackCount) && Number.isInteger(facts.tracedTrackCount) && facts.recordedTrackCount >= 0 && facts.tracedTrackCount >= 0, 'CASE_EVIDENCE')
    return facts.releaseRelationType === 'release-link' && facts.recordedLineageType === 'recorded-track-lineage' && facts.recordedTrackCount > 0 && facts.tracedTrackCount === facts.recordedTrackCount
  }
  if (scopeId === 'A-02') {
    exactKeys(facts, ['roonEntryAlias', 'sourceAlias', 'sourceSha256', 'mappingSha256', 'mappingConfirmedAt', 'mappingConfirmed'], 'CASE_EVIDENCE')
    check(safeLabel(facts.roonEntryAlias) && safeLabel(facts.sourceAlias) && sha256(facts.sourceSha256) && sha256(facts.mappingSha256), 'CASE_EVIDENCE')
    check(canonicalTimestamp(facts.mappingConfirmedAt) && typeof facts.mappingConfirmed === 'boolean', 'CASE_EVIDENCE')
    return facts.mappingConfirmed === true
  }
  if (scopeId === 'B-09') {
    exactKeys(facts, ['actionKind', 'beforeStateSha256', 'afterStateSha256', 'eventCorrelationSha256', 'changeObserved', 'attemptState', 'exclusiveControlClaimed'], 'CASE_EVIDENCE')
    check(['roon-track-change', 'roon-zone-change', 'roon-output-change'].includes(facts.actionKind), 'CASE_EVIDENCE')
    check(sha256(facts.beforeStateSha256) && sha256(facts.afterStateSha256) && sha256(facts.eventCorrelationSha256), 'CASE_EVIDENCE')
    check(typeof facts.changeObserved === 'boolean' && ['interrupted', 'not-interrupted'].includes(facts.attemptState) && typeof facts.exclusiveControlClaimed === 'boolean', 'CASE_EVIDENCE')
    return facts.beforeStateSha256 !== facts.afterStateSha256 && facts.changeObserved === true && facts.attemptState === 'interrupted' && facts.exclusiveControlClaimed === false
  }
  if (scopeId === 'U-01') {
    exactKeys(facts, ['physicalItemTypes', 'singleLibraryVisible', 'relationClassesObserved', 'unmatchedVisible'], 'CASE_EVIDENCE')
    check(Array.isArray(facts.physicalItemTypes) && JSON.stringify(facts.physicalItemTypes) === JSON.stringify(['cd', 'original-cassette']), 'CASE_EVIDENCE')
    check(Array.isArray(facts.relationClassesObserved) && new Set(facts.relationClassesObserved).size === facts.relationClassesObserved.length, 'CASE_EVIDENCE')
    check(typeof facts.singleLibraryVisible === 'boolean' && typeof facts.unmatchedVisible === 'boolean', 'CASE_EVIDENCE')
    return facts.singleLibraryVisible === true && facts.unmatchedVisible === true && JSON.stringify(facts.relationClassesObserved) === JSON.stringify(['exact', 'probable', 'related', 'unmatched'])
  }
  if (scopeId === 'U-06') {
    exactKeys(facts, ['albumCount', 'trackCount', 'tracedTrackCount', 'recordingType', 'commercialExactCreated', 'originalInventoryIncrement'], 'CASE_EVIDENCE')
    check([facts.albumCount, facts.trackCount, facts.tracedTrackCount, facts.originalInventoryIncrement].every(value => Number.isInteger(value) && value >= 0), 'CASE_EVIDENCE')
    check(['self-recorded', 'commercial-original'].includes(facts.recordingType) && typeof facts.commercialExactCreated === 'boolean', 'CASE_EVIDENCE')
    return facts.albumCount >= 2 && facts.trackCount > 0 && facts.tracedTrackCount === facts.trackCount && facts.recordingType === 'self-recorded' && facts.commercialExactCreated === false && facts.originalInventoryIncrement === 0
  }
  if (scopeId === 'U-07') {
    exactKeys(facts, ['selectionObserved', 'sourceVerified', 'logicCompleted', 'recommendationLabel', 'reasonShown', 'playbackTakeoverCount', 'reservationCount', 'formalStartCount'], 'CASE_EVIDENCE')
    check(['selectionObserved', 'sourceVerified', 'logicCompleted', 'reasonShown'].every(key => typeof facts[key] === 'boolean'), 'CASE_EVIDENCE')
    check(['preliminary-estimate', 'formal-ready'].includes(facts.recommendationLabel), 'CASE_EVIDENCE')
    check([facts.playbackTakeoverCount, facts.reservationCount, facts.formalStartCount].every(value => Number.isInteger(value) && value >= 0), 'CASE_EVIDENCE')
    return facts.selectionObserved === true && facts.sourceVerified === false && facts.logicCompleted === false && facts.recommendationLabel === 'preliminary-estimate' && facts.reasonShown === true && facts.playbackTakeoverCount === 0 && facts.reservationCount === 0 && facts.formalStartCount === 0
  }
  if (scopeId === 'U-10') {
    exactKeys(facts, ['attemptAlias', 'physicalCopyAlias', 'eventCorrelationSha256', 'interruptionKind', 'roonAvailableBefore', 'roonAvailableAfter', 'attemptState', 'completedClaimed', 'blankInventoryIncrement', 'physicalRecordPreserved', 'historyPreserved', 'manualBackfillMarkerPreserved'], 'CASE_EVIDENCE')
    check(safeLabel(facts.attemptAlias) && safeLabel(facts.physicalCopyAlias) && sha256(facts.eventCorrelationSha256), 'CASE_EVIDENCE')
    check(facts.interruptionKind === 'roon-offline', 'CASE_EVIDENCE')
    check(['roonAvailableBefore', 'roonAvailableAfter', 'completedClaimed', 'physicalRecordPreserved', 'historyPreserved', 'manualBackfillMarkerPreserved'].every(key => typeof facts[key] === 'boolean'), 'CASE_EVIDENCE')
    check(['interrupted', 'completed'].includes(facts.attemptState) && Number.isInteger(facts.blankInventoryIncrement) && facts.blankInventoryIncrement >= 0, 'CASE_EVIDENCE')
    return facts.roonAvailableBefore === true && facts.roonAvailableAfter === false && facts.attemptState === 'interrupted' && facts.completedClaimed === false && facts.blankInventoryIncrement === 0 && facts.physicalRecordPreserved === true && facts.historyPreserved === true && facts.manualBackfillMarkerPreserved === true
  }
  fail('CASE_EVIDENCE')
}

function validateRealRoonCase(receipt, artifacts, artifactContents, entry) {
  const scopeId = receipt.scopeIds[0]
  const contract = REAL_ROON_CASES.get(scopeId)
  const criterionSha256 = createHash('sha256').update(JSON.stringify(entry.source)).digest('hex')
  const caseArtifact = parseSingleArtifact(artifacts, artifactContents, 'case-evidence')
  check(JSON.stringify(caseArtifact.value) === JSON.stringify(receipt.caseEvidence), 'CASE_EVIDENCE')
  exactKeys(receipt.caseEvidence, ['type', 'externalKind', 'correlationSha256', 'criterionSha256', 'connectionState', 'observedOutcome', 'criterionSatisfied', 'observationArtifactIds'], 'CASE_EVIDENCE')
  const evidence = receipt.caseEvidence
  check(contract !== undefined && evidence.type === 'real-roon' && evidence.externalKind === 'real-roon' && sha256(evidence.correlationSha256) && evidence.criterionSha256 === criterionSha256, 'CASE_EVIDENCE')
  check(['connected', 'offline-observed', 'unavailable'].includes(evidence.connectionState) && typeof evidence.criterionSatisfied === 'boolean', 'CASE_EVIDENCE')
  check(evidence.observedOutcome === contract.outcome || evidence.observedOutcome === null, 'CASE_EVIDENCE')
  check(Array.isArray(evidence.observationArtifactIds) && evidence.observationArtifactIds.length === 1 && new Set(evidence.observationArtifactIds).size === 1, 'CASE_EVIDENCE')
  const artifactId = evidence.observationArtifactIds[0]
  const artifact = artifacts.find(value => value.artifactId === artifactId)
  check(artifact?.role === 'external-observation' && artifactContents.has(artifactId), 'CASE_EVIDENCE')
  let observation
  try { observation = JSON.parse(artifactContents.get(artifactId).toString('utf8')) } catch { fail('CASE_EVIDENCE') }
  exactKeys(observation, ['roonEnvironmentAlias', 'connectionState', 'observerRelativePath', 'observerSha256', 'correlationSha256', 'observedAt', 'facts', 'factsSha256'], 'CASE_EVIDENCE')
  check(safeLabel(observation.roonEnvironmentAlias) && observation.connectionState === evidence.connectionState, 'CASE_EVIDENCE')
  check(safeArtifactPath(observation.observerRelativePath) && !path.isAbsolute(observation.observerRelativePath) && sha256(observation.observerSha256), 'CASE_EVIDENCE')
  check(observation.correlationSha256 === evidence.correlationSha256 && canonicalTimestamp(observation.observedAt), 'CASE_EVIDENCE')
  check(observation.factsSha256 === createHash('sha256').update(JSON.stringify(observation.facts)).digest('hex'), 'CASE_EVIDENCE')
  const environment = parseSingleArtifact(artifacts, artifactContents, 'environment-seal')
  check(environment.value?.roonEnvironmentAlias === observation.roonEnvironmentAlias, 'CASE_EVIDENCE')
  const manifest = parseSingleArtifact(artifacts, artifactContents, 'candidate-manifest')
  check(manifest.value?.controlledFiles?.some(value => value.relativePath === observation.observerRelativePath && value.sha256 === observation.observerSha256), 'CASE_EVIDENCE')
  const preflight = parseSingleArtifact(artifacts, artifactContents, 'preflight-seal')
  const authorization = parseSingleArtifact(artifacts, artifactContents, 'authorization-seal')
  const times = [preflight.value.observedAt, observation.observedAt, receipt.observedAt, authorization.value.expiresAt].map(Date.parse)
  check(times.every(Number.isFinite) && times.every((value, index) => index === 0 || times[index - 1] <= value), 'CASE_EVIDENCE')
  const factsPassed = validateRealRoonFacts(scopeId, observation.facts)
  const passed = evidence.connectionState === contract.connectionState && factsPassed
  check(evidence.criterionSatisfied === passed, 'CASE_EVIDENCE')
  check(receipt.verdict === 'passed' ? passed && evidence.observedOutcome === contract.outcome : !passed && evidence.observedOutcome === null, 'CASE_EVIDENCE')
  return criterionSha256
}

function validateHardwareFacts(scopeId, facts, root, receipt, authorizationGrantedAt) {
  const configurationKeys = ['configurationCertificateId', 'configurationCertificateSha256', 'certifiedConfigurationFingerprintSha256', 'observedConfigurationFingerprintSha256']
  const validateConfigurationBinding = () => {
    check(safeLabel(facts.configurationCertificateId) && sha256(facts.configurationCertificateSha256), 'CASE_EVIDENCE')
    check(sha256(facts.certifiedConfigurationFingerprintSha256) && sha256(facts.observedConfigurationFingerprintSha256), 'CASE_EVIDENCE')
    validateHardwareConfigurationCertificate(root, facts.configurationCertificateId, facts.configurationCertificateSha256, facts.certifiedConfigurationFingerprintSha256, receipt, authorizationGrantedAt)
    return facts.certifiedConfigurationFingerprintSha256 === facts.observedConfigurationFingerprintSha256
  }
  if (scopeId === 'MVP-16') {
    exactKeys(facts, ['attemptAlias', 'physicalCopyAlias', 'mediaKind', 'sideSequence', 'completionCorrelationSha256', 'sideAStartEventSha256', 'sideAStopEventSha256', 'flipConfirmationSha256', 'sideBStartEventSha256', 'sideBStopEventSha256', 'sideAStartedAt', 'sideAStoppedAt', 'flippedAt', 'sideBStartedAt', 'sideBStoppedAt', 'explicitSideAStartCount', 'explicitSideBStartCount', 'sideAOutputObserved', 'sideAStoppedBeforeFlip', 'flipExplicitlyConfirmed', 'sideBOutputObserved', 'physicalRecordingConfirmed', 'finalVerificationConfirmed', 'attemptState', 'unresolvedInterruptionCount', 'automaticSideBStartCount', 'fallbackCount', ...configurationKeys], 'CASE_EVIDENCE')
    check(safeLabel(facts.attemptAlias) && safeLabel(facts.physicalCopyAlias) && facts.mediaKind === 'cassette', 'CASE_EVIDENCE')
    check(JSON.stringify(facts.sideSequence) === JSON.stringify(['side-a', 'side-b']), 'CASE_EVIDENCE')
    check(facts.completionCorrelationSha256 === receipt.caseEvidence.correlationSha256 && ['sideAStartEventSha256', 'sideAStopEventSha256', 'flipConfirmationSha256', 'sideBStartEventSha256', 'sideBStopEventSha256'].every(key => sha256(facts[key])), 'CASE_EVIDENCE')
    const eventTimes = ['sideAStartedAt', 'sideAStoppedAt', 'flippedAt', 'sideBStartedAt', 'sideBStoppedAt'].map(key => facts[key])
    check(eventTimes.every(canonicalTimestamp) && eventTimes.map(Date.parse).every((value, index, values) => index === 0 || values[index - 1] < value), 'CASE_EVIDENCE')
    check(['sideAOutputObserved', 'sideAStoppedBeforeFlip', 'flipExplicitlyConfirmed', 'sideBOutputObserved', 'physicalRecordingConfirmed', 'finalVerificationConfirmed'].every(key => typeof facts[key] === 'boolean'), 'CASE_EVIDENCE')
    check(['completed', 'interrupted'].includes(facts.attemptState), 'CASE_EVIDENCE')
    check([facts.explicitSideAStartCount, facts.explicitSideBStartCount, facts.unresolvedInterruptionCount, facts.automaticSideBStartCount, facts.fallbackCount].every(value => Number.isInteger(value) && value >= 0), 'CASE_EVIDENCE')
    return validateConfigurationBinding() && facts.explicitSideAStartCount === 1 && facts.explicitSideBStartCount === 1 && facts.sideAOutputObserved === true && facts.sideAStoppedBeforeFlip === true && facts.flipExplicitlyConfirmed === true && facts.sideBOutputObserved === true && facts.physicalRecordingConfirmed === true && facts.finalVerificationConfirmed === true && facts.attemptState === 'completed' && facts.unresolvedInterruptionCount === 0 && facts.automaticSideBStartCount === 0 && facts.fallbackCount === 0
  }
  if (scopeId === 'MVP-18') {
    exactKeys(facts, ['recordingAlias', 'replicaRunAlias', 'targetKind', 'frozenTargetSha256', 'selectedTargetSha256', 'outputEndpointAlias', 'playbackProfileKind', 'outputRunCorrelationSha256', 'outputContentSha256', 'productionProviderReady', 'outputEndpointSignalObserved', 'expectedFrameCount', 'submittedFrameCount', 'observedFrameCount', 'endpointDrained', 'runState', 'automaticSubstitutionCount', 'currentMasterLookupCount', 'currentDefaultProfileLookupCount', 'attemptMutationCount', 'inventoryMutationCount', ...configurationKeys], 'CASE_EVIDENCE')
    check(safeLabel(facts.recordingAlias) && safeLabel(facts.replicaRunAlias) && safeLabel(facts.outputEndpointAlias), 'CASE_EVIDENCE')
    check(['actual-execution', 'original-render'].includes(facts.targetKind) && sha256(facts.frozenTargetSha256) && sha256(facts.selectedTargetSha256), 'CASE_EVIDENCE')
    check(facts.playbackProfileKind === 'replica-playback' && facts.outputRunCorrelationSha256 === receipt.caseEvidence.correlationSha256 && sha256(facts.outputContentSha256), 'CASE_EVIDENCE')
    check(typeof facts.productionProviderReady === 'boolean' && typeof facts.outputEndpointSignalObserved === 'boolean' && typeof facts.endpointDrained === 'boolean' && ['completed', 'interrupted'].includes(facts.runState), 'CASE_EVIDENCE')
    check([facts.expectedFrameCount, facts.submittedFrameCount, facts.observedFrameCount, facts.automaticSubstitutionCount, facts.currentMasterLookupCount, facts.currentDefaultProfileLookupCount, facts.attemptMutationCount, facts.inventoryMutationCount].every(value => Number.isInteger(value) && value >= 0), 'CASE_EVIDENCE')
    return validateConfigurationBinding() && facts.frozenTargetSha256 === facts.selectedTargetSha256 && facts.outputContentSha256 === facts.selectedTargetSha256 && facts.productionProviderReady === true && facts.outputEndpointSignalObserved === true && facts.expectedFrameCount > 0 && facts.submittedFrameCount === facts.expectedFrameCount && facts.observedFrameCount === facts.expectedFrameCount && facts.endpointDrained === true && facts.runState === 'completed' && [facts.automaticSubstitutionCount, facts.currentMasterLookupCount, facts.currentDefaultProfileLookupCount, facts.attemptMutationCount, facts.inventoryMutationCount].every(value => value === 0)
  }
  if (scopeId === 'U-05') {
    exactKeys(facts, ['attemptAlias', 'physicalCopyAlias', 'datasetAlias', 'completionCorrelationSha256', 'completionEventSha256', 'duplicateCompletionEventSha256', 'restartEventSha256', 'physicalRecordingConfirmed', 'beforeInventory', 'afterInventory', 'beforeInventorySha256', 'afterInventorySha256', 'duplicateCompletionSubmissionCount', 'applicationRestartCount', 'recordingRecordDelta', 'selfRecordedLibraryEntryDelta', 'modelContentEntryDelta', 'additionalPhysicalCopyCount', 'samePhysicalCopyAcrossViews', 'postRestartStateSha256', 'preRestartCompletedStateSha256', ...configurationKeys], 'CASE_EVIDENCE')
    check(safeLabel(facts.attemptAlias) && safeLabel(facts.physicalCopyAlias) && safeLabel(facts.datasetAlias), 'CASE_EVIDENCE')
    check(facts.completionCorrelationSha256 === receipt.caseEvidence.correlationSha256 && ['completionEventSha256', 'duplicateCompletionEventSha256', 'restartEventSha256', 'beforeInventorySha256', 'afterInventorySha256'].every(key => sha256(facts[key])), 'CASE_EVIDENCE')
    const inventoryKeys = ['sealedBlank', 'openedBlank', 'recorded', 'total']
    for (const inventory of [facts.beforeInventory, facts.afterInventory]) {
      exactKeys(inventory, inventoryKeys, 'CASE_EVIDENCE')
      check(inventoryKeys.every(key => Number.isInteger(inventory[key]) && inventory[key] >= 0), 'CASE_EVIDENCE')
      check(inventory.total === inventory.sealedBlank + inventory.openedBlank + inventory.recorded, 'CASE_EVIDENCE')
    }
    check(typeof facts.physicalRecordingConfirmed === 'boolean' && typeof facts.samePhysicalCopyAcrossViews === 'boolean', 'CASE_EVIDENCE')
    check([facts.duplicateCompletionSubmissionCount, facts.applicationRestartCount, facts.recordingRecordDelta, facts.selfRecordedLibraryEntryDelta, facts.modelContentEntryDelta, facts.additionalPhysicalCopyCount].every(value => Number.isInteger(value) && value >= 0), 'CASE_EVIDENCE')
    check(sha256(facts.postRestartStateSha256) && sha256(facts.preRestartCompletedStateSha256), 'CASE_EVIDENCE')
    const expectedBefore = { sealedBlank: 5, openedBlank: 1, recorded: 1, total: 7 }
    const expectedAfter = { sealedBlank: 5, openedBlank: 0, recorded: 2, total: 7 }
    const inventoryHashesMatch = facts.beforeInventorySha256 === createHash('sha256').update(JSON.stringify(facts.beforeInventory)).digest('hex') && facts.afterInventorySha256 === createHash('sha256').update(JSON.stringify(facts.afterInventory)).digest('hex')
    return validateConfigurationBinding() && inventoryHashesMatch && facts.physicalRecordingConfirmed === true && JSON.stringify(facts.beforeInventory) === JSON.stringify(expectedBefore) && JSON.stringify(facts.afterInventory) === JSON.stringify(expectedAfter) && facts.duplicateCompletionSubmissionCount >= 1 && facts.applicationRestartCount >= 1 && facts.recordingRecordDelta === 1 && facts.selfRecordedLibraryEntryDelta === 1 && facts.modelContentEntryDelta === 1 && facts.additionalPhysicalCopyCount === 0 && facts.samePhysicalCopyAcrossViews === true && facts.postRestartStateSha256 === facts.preRestartCompletedStateSha256
  }
  if (scopeId === 'U-10') {
    exactKeys(facts, ['attemptAlias', 'physicalCopyAlias', 'eventCorrelationSha256', 'interruptionKind', 'physicalStopObserved', 'attemptState', 'completedClaimed', 'automaticResumeCount', 'automaticRerecordCount', 'blankInventoryIncrement', 'possibleWriteStatePreserved', 'physicalRecordPreserved', 'historyPreserved', 'manualBackfillMarkerPreserved', ...configurationKeys], 'CASE_EVIDENCE')
    check(safeLabel(facts.attemptAlias) && safeLabel(facts.physicalCopyAlias) && sha256(facts.eventCorrelationSha256), 'CASE_EVIDENCE')
    check(['roon-offline', 'device-removed', 'route-changed', 'asset-failure', 'engine-terminated', 'manual-stop'].includes(facts.interruptionKind), 'CASE_EVIDENCE')
    check(['physicalStopObserved', 'completedClaimed', 'possibleWriteStatePreserved', 'physicalRecordPreserved', 'historyPreserved', 'manualBackfillMarkerPreserved'].every(key => typeof facts[key] === 'boolean'), 'CASE_EVIDENCE')
    check(['interrupted', 'completed'].includes(facts.attemptState), 'CASE_EVIDENCE')
    check([facts.automaticResumeCount, facts.automaticRerecordCount, facts.blankInventoryIncrement].every(value => Number.isInteger(value) && value >= 0), 'CASE_EVIDENCE')
    return validateConfigurationBinding() && facts.physicalStopObserved === true && facts.attemptState === 'interrupted' && facts.completedClaimed === false && facts.automaticResumeCount === 0 && facts.automaticRerecordCount === 0 && facts.blankInventoryIncrement === 0 && facts.possibleWriteStatePreserved === true && facts.physicalRecordPreserved === true && facts.historyPreserved === true && facts.manualBackfillMarkerPreserved === true
  }
  fail('CASE_EVIDENCE')
}

function validateHardwareDependencies(root, dependencies, scopeId, receipt, configurationFingerprintSha256, authorizationGrantedAt, hardwareFacts) {
  const expectedScopes = scopeId === 'MVP-16' ? ['B-07', 'B-14'] : scopeId === 'U-05' ? ['B-14'] : scopeId === 'U-10' ? ['B-09'] : []
  check(Array.isArray(dependencies) && dependencies.length === expectedScopes.length, 'CASE_EVIDENCE')
  check(JSON.stringify(dependencies.map(value => value.scopeId)) === JSON.stringify(expectedScopes), 'CASE_EVIDENCE')
  const ids = new Set()
  for (const dependency of dependencies) {
    exactKeys(dependency, ['receiptId', 'receiptSha256', 'scopeId'], 'CASE_EVIDENCE')
    check(safeLabel(dependency.receiptId) && sha256(dependency.receiptSha256) && !ids.has(dependency.receiptId), 'CASE_EVIDENCE')
    ids.add(dependency.receiptId)
    const relativePath = `${EVIDENCE_ROOT}/receipts/${dependency.receiptId}.json`
    let bytes
    try {
      checkUntracked(root, relativePath)
      bytes = safeFile(root, relativePath, { exactPath: relativePath })
      validateReceiptSeal(root, dependency.receiptId, bytes)
    } catch { fail('CASE_EVIDENCE') }
    check(createHash('sha256').update(bytes).digest('hex') === dependency.receiptSha256, 'CASE_EVIDENCE')
    let envelope
    try { envelope = JSON.parse(bytes.toString('utf8')) } catch { fail('CASE_EVIDENCE') }
    const technical = envelope?.receipt
    check(technical?.receiptId === dependency.receiptId && technical.kind === 'real-output-measurement' && JSON.stringify(technical.scopeIds) === JSON.stringify([dependency.scopeId]), 'CASE_EVIDENCE')
    check(technical.verdict === 'passed' && technical.candidateCommit === receipt.candidateCommit && technical.candidateTree === receipt.candidateTree && technical.matrixSha256 === receipt.matrixSha256, 'CASE_EVIDENCE')
    check(technical.configurationFingerprintSha256 === configurationFingerprintSha256 && Date.parse(technical.observedAt) <= Date.parse(authorizationGrantedAt), 'CASE_EVIDENCE')
    let result
    try { result = validateV3EvidenceEnvelope(envelope, { root }) } catch { fail('CASE_EVIDENCE') }
    check(result.verdict === 'passed', 'CASE_EVIDENCE')
    const bindingArtifacts = technical.artifacts.filter(artifact => artifact.role === 'hardware-subject-binding' && artifact.mediaType === 'application/json')
    check(bindingArtifacts.length === 1, 'CASE_EVIDENCE')
    const bindingArtifact = bindingArtifacts[0]
    let bindingBytes
    try { bindingBytes = safeFile(root, bindingArtifact.relativePath, { prefix: `${EVIDENCE_ROOT}/receipts/${technical.receiptId}` }) } catch { fail('CASE_EVIDENCE') }
    check(bindingBytes.length === bindingArtifact.sizeBytes && createHash('sha256').update(bindingBytes).digest('hex') === bindingArtifact.sha256, 'CASE_EVIDENCE')
    let binding
    try { binding = JSON.parse(bindingBytes.toString('utf8')) } catch { fail('CASE_EVIDENCE') }
    exactKeys(binding, ['scopeId', 'windowCorrelationSha256', 'attemptAlias', 'physicalCopyAlias', 'side', 'eventCorrelationSha256', 'completionCorrelationSha256'], 'CASE_EVIDENCE')
    check(binding.scopeId === dependency.scopeId && binding.windowCorrelationSha256 === receipt.caseEvidence.correlationSha256, 'CASE_EVIDENCE')
    check(binding.attemptAlias === hardwareFacts.attemptAlias && binding.physicalCopyAlias === hardwareFacts.physicalCopyAlias, 'CASE_EVIDENCE')
    if (dependency.scopeId === 'B-07') check(binding.side === 'side-a' && binding.eventCorrelationSha256 === null && binding.completionCorrelationSha256 === null, 'CASE_EVIDENCE')
    if (dependency.scopeId === 'B-14') check(binding.side === 'both-sides' && binding.eventCorrelationSha256 === null && binding.completionCorrelationSha256 === hardwareFacts.completionCorrelationSha256, 'CASE_EVIDENCE')
    if (dependency.scopeId === 'B-09') {
      check(binding.side === null && binding.eventCorrelationSha256 === hardwareFacts.eventCorrelationSha256 && binding.completionCorrelationSha256 === null, 'CASE_EVIDENCE')
      check(technical.caseEvidence?.correlationSha256 === binding.windowCorrelationSha256 && technical.caseEvidence?.eventCorrelationSha256 === binding.eventCorrelationSha256, 'CASE_EVIDENCE')
    }
  }
}

function validateHardwareCase(receipt, artifacts, artifactContents, entry, root) {
  const scopeId = receipt.scopeIds[0]
  const contract = HARDWARE_CASES.get(scopeId)
  const criterionSha256 = createHash('sha256').update(JSON.stringify(entry.source)).digest('hex')
  const caseArtifact = parseSingleArtifact(artifacts, artifactContents, 'case-evidence')
  check(JSON.stringify(caseArtifact.value) === JSON.stringify(receipt.caseEvidence), 'CASE_EVIDENCE')
  exactKeys(receipt.caseEvidence, ['type', 'externalKind', 'correlationSha256', 'criterionSha256', 'dependencyReceiptsSha256', 'observedOutcome', 'criterionSatisfied', 'observationArtifactIds'], 'CASE_EVIDENCE')
  const evidence = receipt.caseEvidence
  check(contract !== undefined && evidence.type === 'hardware' && evidence.externalKind === 'hardware' && sha256(evidence.correlationSha256) && evidence.criterionSha256 === criterionSha256 && sha256(evidence.dependencyReceiptsSha256), 'CASE_EVIDENCE')
  check(typeof evidence.criterionSatisfied === 'boolean' && (evidence.observedOutcome === contract.outcome || evidence.observedOutcome === null), 'CASE_EVIDENCE')
  check(Array.isArray(evidence.observationArtifactIds) && JSON.stringify(evidence.observationArtifactIds) === JSON.stringify(['external-observation']), 'CASE_EVIDENCE')
  const artifact = artifacts.find(value => value.artifactId === 'external-observation')
  check(artifact?.role === 'external-observation' && artifactContents.has(artifact.artifactId), 'CASE_EVIDENCE')
  let observation
  try { observation = JSON.parse(artifactContents.get(artifact.artifactId).toString('utf8')) } catch { fail('CASE_EVIDENCE') }
  exactKeys(observation, ['hardwareEnvironmentAlias', 'observerRelativePath', 'observerSha256', 'correlationSha256', 'observedAt', 'dependencyReceipts', 'facts', 'factsSha256'], 'CASE_EVIDENCE')
  check(safeLabel(observation.hardwareEnvironmentAlias) && safeArtifactPath(observation.observerRelativePath) && !path.isAbsolute(observation.observerRelativePath), 'CASE_EVIDENCE')
  check(observation.observerRelativePath === contract.observerPath, 'CASE_EVIDENCE')
  check(sha256(observation.observerSha256) && observation.correlationSha256 === evidence.correlationSha256 && canonicalTimestamp(observation.observedAt), 'CASE_EVIDENCE')
  check(observation.factsSha256 === createHash('sha256').update(JSON.stringify(observation.facts)).digest('hex'), 'CASE_EVIDENCE')
  check(evidence.dependencyReceiptsSha256 === createHash('sha256').update(JSON.stringify(observation.dependencyReceipts)).digest('hex'), 'CASE_EVIDENCE')
  const environment = parseSingleArtifact(artifacts, artifactContents, 'environment-seal')
  check(environment.value?.hardwareEnvironmentAlias === observation.hardwareEnvironmentAlias, 'CASE_EVIDENCE')
  const manifest = parseSingleArtifact(artifacts, artifactContents, 'candidate-manifest')
  check(manifest.value?.controlledFiles?.some(value => value.relativePath === observation.observerRelativePath && value.sha256 === observation.observerSha256), 'CASE_EVIDENCE')
  const preflight = parseSingleArtifact(artifacts, artifactContents, 'preflight-seal')
  const authorization = parseSingleArtifact(artifacts, artifactContents, 'authorization-seal')
  const times = [preflight.value.observedAt, observation.observedAt, receipt.observedAt, authorization.value.expiresAt].map(Date.parse)
  check(times.every(Number.isFinite) && times.every((value, index) => index === 0 || times[index - 1] <= value), 'CASE_EVIDENCE')
  const passed = validateHardwareFacts(scopeId, observation.facts, root, receipt, authorization.value.grantedAt)
  validateHardwareDependencies(root, observation.dependencyReceipts, scopeId, receipt, observation.facts.certifiedConfigurationFingerprintSha256, authorization.value.grantedAt, observation.facts)
  check(evidence.criterionSatisfied === passed, 'CASE_EVIDENCE')
  check(receipt.verdict === 'passed' ? passed && evidence.observedOutcome === contract.outcome : !passed && evidence.observedOutcome === null, 'CASE_EVIDENCE')
  return criterionSha256
}

function matrixScope(root, scopeId) {
  let bytes
  try {
    bytes = safeFile(root, 'project/V3_ACCEPTANCE.json', { exactPath: 'project/V3_ACCEPTANCE.json', limit: 16 * 1024 * 1024 })
  } catch {
    fail('OWNER_BOUNDARY')
  }
  check(createHash('sha256').update(bytes).digest('hex') === MATRIX_SHA256, 'OWNER_BOUNDARY')
  let matrix
  try { matrix = JSON.parse(bytes.toString('utf8')) } catch { fail('OWNER_BOUNDARY') }
  check(matrix?.task === 'TASK-078' && matrix.formalReady === false && matrix.externalGate === 'NOT_RUN' && Array.isArray(matrix.entries), 'OWNER_BOUNDARY')
  const matches = matrix.entries.filter(entry => entry?.id === scopeId)
  check(matches.length === 1, 'OWNER_BOUNDARY')
  return matches[0]
}

function ownerOnlyScopeHasFreshSoftwareBaseline(root, scopeId) {
  const entry = matrixScope(root, scopeId)
  check(entry.status === 'mapped' && entry.freshGate?.state === 'passed' && Array.isArray(entry.freshGate.evidenceIds) && entry.freshGate.evidenceIds.length > 0, 'OWNER_BOUNDARY')
  check(Array.isArray(entry.externalRequirements) && entry.externalRequirements.length > 0, 'OWNER_BOUNDARY')
  check(entry.externalRequirements.every(requirement => requirement?.kind === 'owner' && requirement.state === 'not-run'), 'OWNER_BOUNDARY')
  return true
}

function declaredExternalKinds(root, scopeId, { requireFreshSoftware }) {
  const entry = matrixScope(root, scopeId)
  if (requireFreshSoftware) check(entry.status === 'mapped' && entry.freshGate?.state === 'passed', 'OWNER_BOUNDARY')
  check(Array.isArray(entry.externalRequirements) && entry.externalRequirements.length > 0, 'OWNER_BOUNDARY')
  const kinds = entry.externalRequirements.map(requirement => requirement?.kind)
  check(kinds.every(kind => ['owner', 'real-input', 'real-logic', 'real-roon', 'hardware'].includes(kind)) && new Set(kinds).size === kinds.length, 'OWNER_BOUNDARY')
  check(entry.externalRequirements.every(requirement => requirement?.state === 'not-run'), 'OWNER_BOUNDARY')
  return new Set(kinds.filter(kind => kind !== 'owner'))
}

function requiredExternalKinds(root, scopeId) {
  return declaredExternalKinds(root, scopeId, { requireFreshSoftware: true })
}

function readExternalObservation(root, technicalReceipt) {
  const matches = technicalReceipt.artifacts.filter(artifact => artifact.role === 'external-observation' && artifact.mediaType === 'application/json')
  check(matches.length === 1, 'OWNER_BOUNDARY')
  const artifact = matches[0]
  const bytes = safeFile(root, artifact.relativePath, { prefix: `${EVIDENCE_ROOT}/receipts/${technicalReceipt.receiptId}` })
  check(bytes.length === artifact.sizeBytes && createHash('sha256').update(bytes).digest('hex') === artifact.sha256, 'OWNER_BOUNDARY')
  try { return JSON.parse(bytes.toString('utf8')) } catch { fail('OWNER_BOUNDARY') }
}

function validateReceipt(receipt, root) {
  exactKeys(receipt, [
    'receiptId',
    'kind',
    'scopeIds',
    'observedAt',
    'candidateCommit',
    'candidateTree',
    'candidateManifestSha256',
    'matrixSha256',
    'authorizationSha256',
    'planSha256',
    'preflightSha256',
    'environmentFingerprint',
    'configuration',
    'configurationFingerprintSha256',
    'artifacts',
    'verdict',
    'reasonCodes',
    'measurements',
    'caseEvidence',
    'ownerDecision',
    'referencedTechnicalReceipts',
  ], 'RECEIPT_STATE')
  check(safeLabel(receipt.receiptId) && EVIDENCE_KINDS.has(receipt.kind), 'RECEIPT_STATE')
  check(canonicalTimestamp(receipt.observedAt), 'RECEIPT_STATE')
  check(gitSha(receipt.candidateCommit) && receipt.candidateCommit !== BASE_COMMIT && !/^([0-9a-f])\1{39}$/u.test(receipt.candidateCommit), 'RECEIPT_STATE')
  check(gitSha(receipt.candidateTree) && !/^([0-9a-f])\1{39}$/u.test(receipt.candidateTree) && sha256(receipt.candidateManifestSha256), 'RECEIPT_STATE')
  check(receipt.matrixSha256 === MATRIX_SHA256, 'RECEIPT_STATE')
  check(sha256(receipt.authorizationSha256) && sha256(receipt.planSha256) && sha256(receipt.preflightSha256) && sha256(receipt.environmentFingerprint), 'RECEIPT_STATE')
  if (TECHNICAL_KINDS.has(receipt.kind)) check(['passed', 'failed', 'timed-out', 'stopped', 'inconclusive'].includes(receipt.verdict), 'RECEIPT_STATE')
  else check(receipt.kind === 'owner-observed' && receipt.verdict === null, 'OWNER_BOUNDARY')
  check(Array.isArray(receipt.reasonCodes) && receipt.reasonCodes.length <= 16 && new Set(receipt.reasonCodes).size === receipt.reasonCodes.length && receipt.reasonCodes.every(safeLabel), 'RECEIPT_STATE')
  if (receipt.kind === 'owner-observed' || receipt.verdict === 'passed') check(receipt.reasonCodes.length === 0, 'RECEIPT_STATE')
  else check(receipt.reasonCodes.length > 0, 'RECEIPT_STATE')
  check(Array.isArray(receipt.scopeIds) && receipt.scopeIds.length === 1, 'SCOPE')
  const scopes = new Set(receipt.scopeIds)
  check(scopes.size === receipt.scopeIds.length && receipt.scopeIds.every(scope => SCOPE_IDS.has(scope)), 'SCOPE')
  check(Array.isArray(receipt.artifacts) && receipt.artifacts.length <= 32, 'ARTIFACT')
  if (TECHNICAL_KINDS.has(receipt.kind)) check(receipt.artifacts.length > 0, 'ARTIFACT')
  else check(receipt.artifacts.length === 0, 'OWNER_BOUNDARY')
  check(receipt.artifacts.reduce((total, artifact) => total + (Number.isInteger(artifact.sizeBytes) ? artifact.sizeBytes : 0), 0) <= 256 * 1024 * 1024, 'ARTIFACT')
  const artifactContents = new Map()
  for (const artifact of receipt.artifacts) artifactContents.set(artifact.artifactId, validateArtifact(root, artifact, TECHNICAL_KINDS.has(receipt.kind) ? receipt.receiptId : null))
  check(new Set(receipt.artifacts.map(artifact => artifact.artifactId)).size === receipt.artifacts.length, 'ARTIFACT')
  check(new Set(receipt.artifacts.map(artifact => artifact.relativePath)).size === receipt.artifacts.length, 'ARTIFACT')

  if (receipt.kind === 'real-output-measurement') {
    const gateId = receipt.scopeIds[0]
    check(OUTPUT_SCOPES.has(gateId), 'SCOPE')
    validateConfiguration(receipt.configuration)
    check(sha256(receipt.configurationFingerprintSha256) && receipt.configurationFingerprintSha256 === configurationFingerprint(receipt.configuration), 'CONFIGURATION')
    validateTechnicalSeals(receipt, receipt.artifacts, artifactContents)
    check(receipt.ownerDecision === null && Array.isArray(receipt.referencedTechnicalReceipts) && receipt.referencedTechnicalReceipts.length === 0, 'OWNER_BOUNDARY')
    let measurementPassed = true
    if (['B-09', 'B-10', 'B-11', 'B-12'].includes(gateId)) measurementPassed = validateMeasurements(receipt.measurements, receipt.verdict, receipt.configuration, receipt.artifacts, artifactContents)
    else check(receipt.measurements === null, 'MEASUREMENT')
    const casePassed = validateCaseEvidence(receipt.caseEvidence, gateId, receipt.receiptId, receipt.configurationFingerprintSha256, receipt.verdict, receipt.artifacts, artifactContents, root)
    if (receipt.verdict !== 'passed') {
      check(casePassed === false || measurementPassed === false, ['B-09', 'B-10', 'B-11', 'B-12'].includes(gateId) ? 'MEASUREMENT' : 'CASE_EVIDENCE')
      check(receipt.reasonCodes.every(reason => NONPASS_REASONS[gateId].has(reason)), 'RECEIPT_STATE')
    }
  } else if (receipt.kind === 'real-input-observation') {
    const scopeId = receipt.scopeIds[0]
    check(!OUTPUT_SCOPES.has(scopeId), 'SCOPE')
    const expectedRoles = ['authorization-seal', 'candidate-manifest', 'case-evidence', 'environment-seal', 'external-observation', 'plan-seal', 'preflight-seal'].sort()
    check(JSON.stringify(receipt.artifacts.map(artifact => artifact.role).sort()) === JSON.stringify(expectedRoles), 'ARTIFACT')
    const entry = matrixScope(root, scopeId)
    check(Array.isArray(entry.externalRequirements) && entry.externalRequirements.some(requirement => requirement?.kind === 'real-input' && requirement.state === 'not-run'), 'SCOPE')
    check(receipt.configuration === null && receipt.configurationFingerprintSha256 === null && receipt.measurements === null, 'CONFIGURATION')
    check(receipt.ownerDecision === null && Array.isArray(receipt.referencedTechnicalReceipts) && receipt.referencedTechnicalReceipts.length === 0, 'OWNER_BOUNDARY')
    const criterionSha256 = validateRealInputCase(receipt, receipt.artifacts, artifactContents, entry)
    validateExternalSeals(receipt, receipt.artifacts, artifactContents, criterionSha256, {
      externalKind: 'real-input',
      environmentAliasKey: 'dataSourceAlias',
      allowedOperations: ['read-source', 'hash-source'],
      allowedDataClasses: ['anonymous-real-input'],
    })
    if (receipt.verdict !== 'passed') check(receipt.reasonCodes.every(reason => REAL_INPUT_NONPASS_REASONS.has(reason)), 'RECEIPT_STATE')
  } else if (receipt.kind === 'real-logic-observation') {
    const scopeId = receipt.scopeIds[0]
    check(!OUTPUT_SCOPES.has(scopeId), 'SCOPE')
    const expectedRoles = ['authorization-seal', 'candidate-manifest', 'case-evidence', 'environment-seal', 'external-observation', 'plan-seal', 'preflight-seal'].sort()
    check(JSON.stringify(receipt.artifacts.map(artifact => artifact.role).sort()) === JSON.stringify(expectedRoles), 'ARTIFACT')
    const entry = matrixScope(root, scopeId)
    check(Array.isArray(entry.externalRequirements) && entry.externalRequirements.some(requirement => requirement?.kind === 'real-logic' && requirement.state === 'not-run'), 'SCOPE')
    check(receipt.configuration === null && receipt.configurationFingerprintSha256 === null && receipt.measurements === null, 'CONFIGURATION')
    check(receipt.ownerDecision === null && Array.isArray(receipt.referencedTechnicalReceipts) && receipt.referencedTechnicalReceipts.length === 0, 'OWNER_BOUNDARY')
    const criterionSha256 = validateRealLogicCase(receipt, receipt.artifacts, artifactContents, entry)
    validateExternalSeals(receipt, receipt.artifacts, artifactContents, criterionSha256, {
      externalKind: 'real-logic',
      environmentAliasKey: 'logicWorkspaceAlias',
      allowedOperations: ['open-workspace', 'read-export', 'hash-export', 'inspect-marker', 'inspect-timeline'],
      allowedDataClasses: ['anonymous-real-logic'],
    })
    if (receipt.verdict !== 'passed') check(receipt.reasonCodes.every(reason => REAL_LOGIC_NONPASS_REASONS.has(reason)), 'RECEIPT_STATE')
  } else if (receipt.kind === 'real-roon-observation') {
    const scopeId = receipt.scopeIds[0]
    const contract = REAL_ROON_CASES.get(scopeId)
    check(contract !== undefined, 'SCOPE')
    const expectedRoles = ['authorization-seal', 'candidate-manifest', 'case-evidence', 'environment-seal', 'external-observation', 'plan-seal', 'preflight-seal'].sort()
    check(JSON.stringify(receipt.artifacts.map(artifact => artifact.role).sort()) === JSON.stringify(expectedRoles), 'ARTIFACT')
    const entry = matrixScope(root, scopeId)
    check(Array.isArray(entry.externalRequirements) && entry.externalRequirements.some(requirement => requirement?.kind === 'real-roon' && requirement.state === 'not-run'), 'SCOPE')
    check(receipt.configuration === null && receipt.configurationFingerprintSha256 === null && receipt.measurements === null, 'CONFIGURATION')
    check(receipt.ownerDecision === null && Array.isArray(receipt.referencedTechnicalReceipts) && receipt.referencedTechnicalReceipts.length === 0, 'OWNER_BOUNDARY')
    const criterionSha256 = validateRealRoonCase(receipt, receipt.artifacts, artifactContents, entry)
    validateExternalSeals(receipt, receipt.artifacts, artifactContents, criterionSha256, {
      externalKind: 'real-roon',
      environmentAliasKey: 'roonEnvironmentAlias',
      allowedOperations: contract.operations,
      allowedDataClasses: ['anonymous-real-roon'],
    })
    if (receipt.verdict === 'failed') check(receipt.reasonCodes.length === 1 && REAL_ROON_FAILED_REASONS.has(receipt.reasonCodes[0]), 'RECEIPT_STATE')
    if (receipt.verdict === 'timed-out') check(JSON.stringify(receipt.reasonCodes) === JSON.stringify(['roon-observation-timeout']), 'RECEIPT_STATE')
    if (receipt.verdict === 'stopped') check(JSON.stringify(receipt.reasonCodes) === JSON.stringify(['operation-stopped']), 'RECEIPT_STATE')
    if (receipt.verdict === 'inconclusive') check(JSON.stringify(receipt.reasonCodes) === JSON.stringify(['evidence-inconclusive']), 'RECEIPT_STATE')
  } else if (receipt.kind === 'hardware-observation') {
    const scopeId = receipt.scopeIds[0]
    const contract = HARDWARE_CASES.get(scopeId)
    check(contract !== undefined && !OUTPUT_SCOPES.has(scopeId), 'SCOPE')
    const expectedRoles = ['authorization-seal', 'candidate-manifest', 'case-evidence', 'environment-seal', 'external-observation', 'plan-seal', 'preflight-seal'].sort()
    check(JSON.stringify(receipt.artifacts.map(artifact => artifact.role).sort()) === JSON.stringify(expectedRoles), 'ARTIFACT')
    const entry = matrixScope(root, scopeId)
    check(Array.isArray(entry.externalRequirements) && entry.externalRequirements.some(requirement => requirement?.kind === 'hardware' && requirement.state === 'not-run'), 'SCOPE')
    check(receipt.configuration === null && receipt.configurationFingerprintSha256 === null && receipt.measurements === null, 'CONFIGURATION')
    check(receipt.ownerDecision === null && Array.isArray(receipt.referencedTechnicalReceipts) && receipt.referencedTechnicalReceipts.length === 0, 'OWNER_BOUNDARY')
    const criterionSha256 = validateHardwareCase(receipt, receipt.artifacts, artifactContents, entry, root)
    validateExternalSeals(receipt, receipt.artifacts, artifactContents, criterionSha256, {
      externalKind: 'hardware',
      environmentAliasKey: 'hardwareEnvironmentAlias',
      allowedOperations: contract.operations,
      allowedDataClasses: ['anonymous-hardware'],
      dependencyReceiptsSha256: receipt.caseEvidence.dependencyReceiptsSha256,
    })
    if (receipt.verdict === 'failed') check(receipt.reasonCodes.length === 1 && HARDWARE_FAILED_REASONS.has(receipt.reasonCodes[0]), 'RECEIPT_STATE')
    if (receipt.verdict === 'timed-out') check(JSON.stringify(receipt.reasonCodes) === JSON.stringify(['hardware-observation-timeout']), 'RECEIPT_STATE')
    if (receipt.verdict === 'stopped') check(JSON.stringify(receipt.reasonCodes) === JSON.stringify(['operation-stopped']), 'RECEIPT_STATE')
    if (receipt.verdict === 'inconclusive') check(JSON.stringify(receipt.reasonCodes) === JSON.stringify(['evidence-inconclusive']), 'RECEIPT_STATE')
  } else if (receipt.kind === 'owner-observed') {
    check(receipt.configuration === null && receipt.configurationFingerprintSha256 === null && receipt.measurements === null && receipt.caseEvidence === null, 'OWNER_BOUNDARY')
    check(['accepted', 'rejected', 'deferred'].includes(receipt.ownerDecision), 'OWNER_BOUNDARY')
    check(Array.isArray(receipt.referencedTechnicalReceipts) && receipt.referencedTechnicalReceipts.length <= 32, 'OWNER_BOUNDARY')
    if (receipt.ownerDecision === 'accepted' && receipt.referencedTechnicalReceipts.length === 0) {
      check(!OUTPUT_SCOPES.has(receipt.scopeIds[0]) && ownerOnlyScopeHasFreshSoftwareBaseline(root, receipt.scopeIds[0]), 'OWNER_BOUNDARY')
    }
    const ids = new Set()
    const referencedExternalKinds = new Set()
    const technicalByExternalKind = new Map()
    let hasRealOutput = false
    const required = receipt.ownerDecision === 'accepted' && receipt.referencedTechnicalReceipts.length > 0
      ? OUTPUT_SCOPES.has(receipt.scopeIds[0])
        ? declaredExternalKinds(root, receipt.scopeIds[0], { requireFreshSoftware: false })
        : requiredExternalKinds(root, receipt.scopeIds[0])
      : null
    for (const reference of receipt.referencedTechnicalReceipts) {
      exactKeys(reference, ['receiptId', 'receiptSha256'], 'OWNER_BOUNDARY')
      check(safeLabel(reference.receiptId) && sha256(reference.receiptSha256) && !ids.has(reference.receiptId), 'OWNER_BOUNDARY')
      ids.add(reference.receiptId)
      const relativePath = `${EVIDENCE_ROOT}/receipts/${reference.receiptId}.json`
      checkUntracked(root, relativePath)
      const bytes = safeFile(root, relativePath, { exactPath: relativePath })
      check(createHash('sha256').update(bytes).digest('hex') === reference.receiptSha256, 'OWNER_BOUNDARY')
      validateReceiptSeal(root, reference.receiptId, bytes)
      let technical
      try { technical = JSON.parse(bytes.toString('utf8')) } catch { fail('OWNER_BOUNDARY') }
      check(TECHNICAL_KINDS.has(technical?.receipt?.kind) && technical.receipt.receiptId === reference.receiptId, 'OWNER_BOUNDARY')
      check(technical.receipt.scopeIds?.length === 1 && technical.receipt.scopeIds[0] === receipt.scopeIds[0], 'OWNER_BOUNDARY')
      check(technical.receipt.candidateCommit === receipt.candidateCommit && technical.receipt.candidateTree === receipt.candidateTree && technical.receipt.matrixSha256 === receipt.matrixSha256, 'OWNER_BOUNDARY')
      check(Date.parse(technical.receipt.observedAt) <= Date.parse(receipt.observedAt), 'OWNER_BOUNDARY')
      const result = validateV3EvidenceEnvelope(technical, { root })
      if (receipt.ownerDecision === 'accepted') check(result.verdict === 'passed', 'OWNER_BOUNDARY')
      if (technical.receipt.kind === 'real-output-measurement') hasRealOutput = true
      const externalKind = technical.receipt.kind === 'real-output-measurement' && required?.has('hardware')
        ? 'hardware'
        : technical.receipt.kind === 'real-input-observation'
        ? 'real-input'
        : technical.receipt.kind === 'real-logic-observation'
          ? 'real-logic'
          : technical.receipt.kind === 'real-roon-observation'
            ? 'real-roon'
            : technical.receipt.kind === 'hardware-observation' && !OUTPUT_SCOPES.has(receipt.scopeIds[0])
              ? 'hardware'
            : null
      if (externalKind !== null) {
        check(!referencedExternalKinds.has(externalKind), 'OWNER_BOUNDARY')
        referencedExternalKinds.add(externalKind)
        technicalByExternalKind.set(externalKind, technical.receipt)
      }
    }
    if (receipt.ownerDecision === 'accepted' && receipt.referencedTechnicalReceipts.length > 0) {
      if (OUTPUT_SCOPES.has(receipt.scopeIds[0])) check(hasRealOutput, 'OWNER_BOUNDARY')
      check(required.size === referencedExternalKinds.size && [...required].every(kind => referencedExternalKinds.has(kind)), 'OWNER_BOUNDARY')
      if (receipt.scopeIds[0] === 'B-09') {
        const output = technicalByExternalKind.get('hardware')
        const roon = technicalByExternalKind.get('real-roon')
        check(output?.caseEvidence?.correlationSha256 === roon?.caseEvidence?.correlationSha256, 'OWNER_BOUNDARY')
        const roonObservation = readExternalObservation(root, roon)
        check(output.caseEvidence.eventCorrelationSha256 === roonObservation.facts?.eventCorrelationSha256, 'OWNER_BOUNDARY')
        check(output.caseEvidence.injectionKind === roonObservation.facts?.actionKind, 'OWNER_BOUNDARY')
      }
      if (receipt.scopeIds[0] === 'A-02') {
        const inputObservation = readExternalObservation(root, technicalByExternalKind.get('real-input'))
        const roonObservation = readExternalObservation(root, technicalByExternalKind.get('real-roon'))
        const sourceIndex = inputObservation.sourceAliases?.indexOf(roonObservation.facts?.sourceAlias)
        check(sourceIndex >= 0 && inputObservation.sourceSha256s?.[sourceIndex] === roonObservation.facts?.sourceSha256, 'OWNER_BOUNDARY')
      }
      if (receipt.scopeIds[0] === 'U-10') {
        const hardware = technicalByExternalKind.get('hardware')
        const roon = technicalByExternalKind.get('real-roon')
        check(hardware?.caseEvidence?.correlationSha256 === roon?.caseEvidence?.correlationSha256, 'OWNER_BOUNDARY')
        const hardwareFacts = readExternalObservation(root, hardware).facts
        const roonFacts = readExternalObservation(root, roon).facts
        for (const key of ['attemptAlias', 'physicalCopyAlias', 'eventCorrelationSha256', 'interruptionKind', 'attemptState', 'completedClaimed', 'blankInventoryIncrement', 'physicalRecordPreserved', 'historyPreserved', 'manualBackfillMarkerPreserved']) {
          check(hardwareFacts?.[key] === roonFacts?.[key], 'OWNER_BOUNDARY')
        }
      }
    }
  }
}

export function validateV3EvidenceEnvelope(envelope, { root } = {}) {
  check(typeof root === 'string' && path.isAbsolute(root), 'ROOT_REQUIRED')
  exactKeys(envelope, ['schemaVersion', 'task', 'baseCommit', 'template', 'ready', 'evidenceRoot', 'receipt'])
  check(envelope.schemaVersion === 1 && envelope.task === TASK && envelope.baseCommit === BASE_COMMIT, 'IDENTITY')
  check(envelope.evidenceRoot === EVIDENCE_ROOT && envelope.ready === false, 'IDENTITY')
  if (envelope.template === true) {
    check(envelope.receipt === null, 'TEMPLATE_STATE')
    return { template: true, ready: false, receiptId: null, verdict: null }
  }
  check(envelope.template === false && envelope.receipt !== null, 'RECEIPT_STATE')
  validateReceipt(envelope.receipt, root)
  return { template: false, ready: false, receiptId: envelope.receipt.receiptId, verdict: envelope.receipt.kind === 'owner-observed' ? envelope.receipt.ownerDecision : envelope.receipt.verdict }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const arguments_ = process.argv.slice(2)
    check(arguments_.length === 0 || (arguments_.length === 2 && arguments_[0] === '--receipt-id' && safeLabel(arguments_[1])), 'ARGUMENTS')
    const root = process.cwd()
    const receiptId = arguments_.length === 2 ? arguments_[1] : null
    const relativePath = receiptId ? `${EVIDENCE_ROOT}/receipts/${receiptId}.json` : TEMPLATE_PATH
    const bytes = safeFile(root, relativePath, { exactPath: relativePath })
    let envelope
    try { envelope = JSON.parse(bytes.toString('utf8')) } catch { fail('INVALID_EVIDENCE') }
    const result = validateV3EvidenceEnvelope(envelope, { root })
    if (receiptId) {
      check(result.receiptId === receiptId, 'RECEIPT_STATE')
      checkUntracked(root, relativePath)
      if (TECHNICAL_KINDS.has(envelope.receipt.kind)) {
        validateRepositoryReceiptIdentity(root, envelope.receipt, readControlledFiles(root, envelope))
      } else if (envelope.receipt.referencedTechnicalReceipts.length > 0) {
        for (const reference of envelope.receipt.referencedTechnicalReceipts) {
          const technicalPath = `${EVIDENCE_ROOT}/receipts/${reference.receiptId}.json`
          const technicalBytes = safeFile(root, technicalPath, { exactPath: technicalPath })
          let technicalEnvelope
          try { technicalEnvelope = JSON.parse(technicalBytes.toString('utf8')) } catch { fail('RECEIPT_STATE') }
          validateRepositoryReceiptIdentity(root, technicalEnvelope.receipt, readControlledFiles(root, technicalEnvelope))
        }
      } else {
        validateRepositoryReceiptIdentity(root, envelope.receipt)
      }
      sealReceipt(root, receiptId, bytes)
      console.log(`V3_OWNER_EVIDENCE_RECEIPT=PASS ${JSON.stringify(result)}；单份收据不代表完整TASK-079或V3验收通过。`)
    } else {
      console.log(`V3_OWNER_EVIDENCE_TEMPLATE=PASS ${JSON.stringify(result)}；空模板不是真实证据。`)
    }
  } catch (error) {
    console.error(`V3_OWNER_EVIDENCE=FAIL ${normalizeEvidenceError(error)}`)
    process.exitCode = 1
  }
}
