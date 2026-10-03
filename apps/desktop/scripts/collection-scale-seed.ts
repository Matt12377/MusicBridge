import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync, realpathSync, readFileSync, readdirSync, mkdirSync, writeFileSync, openSync, closeSync, fstatSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCollectionRepository } from '../../../packages/bridge-core/src/collection/repository.js'

export const COLLECTION_SCALE_COUNTS = [0, 100, 2000, 2001, 5000, 5001] as const
export type CollectionScaleCount = typeof COLLECTION_SCALE_COUNTS[number]
export const COLLECTION_SCALE_WORKLOADS = Object.freeze([
  { name: 'all', filter: {} },
  { name: 'brand-stock', filter: { brand: 'RUST015品牌甲', stockState: 'blank' } },
  { name: 'literal', filter: { query: '%_' } },
  { name: 'unicode', filter: { query: '樱花🌸' } },
  { name: 'decade', filter: { decade: 1990 } },
  { name: 'empty', filter: { query: 'RUST015绝不匹配' } },
] as const)
const externalRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
export function collectionScaleDescriptor(ordinal: number) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 5001) throw new Error('合成型号序号未准入。')
  return { brand: ordinal % 2 ? 'RUST015品牌甲' : 'RUST015品牌乙', name: `RUST015 合成型号 ${String(ordinal).padStart(6, '0')}`,
    edition: ordinal % 5 === 0 ? 'RUST015%_literal' : ordinal % 7 === 0 ? 'RUST015樱花🌸' : 'RUST015固定合成',
    year: [null, 1981, 1991][ordinal % 3]!, format: 'cassette' as const, tapeType: 'I' as const, identification: 'verified' as const }
}
export interface CollectionScaleFile { path: string; sha256: string; bytes: number }
export interface CollectionScaleSeedReceipt {
  schemaVersion: 1; task: 'RUST-015'; kind: 'collection-scale-fixture-seed'; profileDirectory: string; profileDev: string; profileIno: string;
  nonce: string; modelCount: CollectionScaleCount; writer: 'Node-before-App'; schema: 'original-CollectionRepository'; handlesClosedBeforeLaunch: true;
  models: { ordinal: number; modelId: string; skuId: string; lotId: string }[]; factsSha256: string; policyModelId: string | null;
  seedDomainLedger: 0; seedMainOutbox: 0; database: CollectionScaleFile; repositoryFullDtoSha256: string;
}
export function assertCollectionScaleFreshProfile(profileDirectory: string, modelCount: unknown, nonce: unknown): asserts modelCount is CollectionScaleCount {
  if (typeof profileDirectory !== 'string' || !profileDirectory.startsWith(externalRoot + '/') || path.resolve(profileDirectory) !== profileDirectory || !(/^musicbridge-ui-diagnostics-[A-Za-z0-9._-]+$/u.test(path.basename(profileDirectory)) || modelCount === 0 && /^musicbridge-task036-startup-[A-Za-z0-9._-]+$/u.test(path.basename(profileDirectory))) || !COLLECTION_SCALE_COUNTS.includes(modelCount as CollectionScaleCount) || !uuid(nonce)) throw new Error('合成profile或静态规模未准入。')
  const volume = lstatSync('/Volumes/LifeWeave'), temp = lstatSync(externalRoot), p = lstatSync(profileDirectory)
  if (!p.isDirectory() || p.isSymbolicLink() || realpathSync(profileDirectory) !== profileDirectory || (p.mode & 0o777) !== 0o700 || p.dev !== temp.dev || volume.dev !== temp.dev || volume.dev === lstatSync('/').dev || readdirSync(profileDirectory).length !== 0) throw new Error('只准全新空白外置0700合成profile。')
}
/** 测试夹具仅在App启动前装入事实；不声明这是Main/outbox或Rust写入能力。 */
export function seedCollectionScaleProfile(profileDirectory: string, modelCount: CollectionScaleCount, nonce: string): CollectionScaleSeedReceipt {
  assertCollectionScaleFreshProfile(profileDirectory, modelCount, nonce)
  const profile = lstatSync(profileDirectory), directory = path.join(profileDirectory, 'data'), filePath = path.join(directory, 'collection.v1.sqlite')
  mkdirSync(directory, { mode: 0o700 })
  let repository = createCollectionRepository({ filePath })
  try { repository.list({ offset: 0, limit: 1 }) } finally { repository.close() }
  const facts: CollectionScaleSeedReceipt['models'] = []
  const db = new DatabaseSync(filePath)
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE')
    const model = db.prepare('INSERT INTO collection_models(id,identity_key,descriptor,policy,minimum_sealed,revision) VALUES (?,?,?,\'normal\',0,1)')
    const sku = db.prepare('INSERT INTO collection_skus(id,model_id,minutes) VALUES (?,?,60)')
    const lot = db.prepare('INSERT INTO inventory_lots(id,sku_id,acquired,sealed,opened,legacy,unknown,quantity_adjustment) VALUES (?,?,1,0,1,0,0,0)')
    for (let ordinal = 1; ordinal <= modelCount; ordinal++) {
      const descriptor = JSON.stringify(collectionScaleDescriptor(ordinal)), modelId = randomUUID(), skuId = randomUUID(), lotId = randomUUID()
      model.run(modelId, digest(descriptor), descriptor); sku.run(skuId, modelId); lot.run(lotId, skuId)
      facts.push({ ordinal, modelId, skuId, lotId })
    }
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)')
    if ((db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>).integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length !== 0 || Number((db.prepare('SELECT count(*) AS n FROM inventory_ledger').get() as { n: number }).n) !== 0) throw new Error('合成事实完整性不合规。')
  } finally { db.close() }
  repository = createCollectionRepository({ filePath })
  const full = []
  try {
    for (let offset = 0; offset < modelCount; offset += 100) {
      const page = repository.list({ offset, limit: 100 }); if (page.total !== modelCount) throw new Error('原Repository完整规模与seed不符。'); full.push(...page.items)
    }
  } finally { repository.close() }
  const handle = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try { if (!fstatSync(handle).isFile()) throw new Error('合成库不是普通文件。'); bytes = readFileSync(handle) } finally { closeSync(handle) }
  const receipt: CollectionScaleSeedReceipt = { schemaVersion: 1, task: 'RUST-015', kind: 'collection-scale-fixture-seed', profileDirectory,
    profileDev: String(profile.dev), profileIno: String(profile.ino), nonce, modelCount, writer: 'Node-before-App', schema: 'original-CollectionRepository',
    handlesClosedBeforeLaunch: true, models: facts, factsSha256: digest(JSON.stringify(facts)), policyModelId: facts[0]?.modelId ?? null,
    seedDomainLedger: 0, seedMainOutbox: 0, database: { path: filePath, sha256: digest(bytes), bytes: bytes.length }, repositoryFullDtoSha256: digest(canonical(full)) }
  writeFileSync(path.join(profileDirectory, 'rust015-seed.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return receipt
}
