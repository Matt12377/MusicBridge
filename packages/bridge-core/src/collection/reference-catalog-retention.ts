import { createHash } from 'node:crypto';
import {
  isCatalogRevision, isCatalogSnapshot, isCatalogMatch, isReferenceSourceDetail, MAX_CATALOG_REFERENCES, MAX_CATALOG_MATCHES,
  type CanonicalReference, type CatalogRevision, type CatalogSnapshot, type CatalogMatch, type ReferenceSourceDetail, type CatalogHistoryRetention,
} from '@music-bridge/contracts';

export class CatalogRetentionError extends Error {
  constructor() { super('旧目录的修订、匹配或快照保留证据不完整；导入已停止。'); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const matchFacts = (matches: readonly CatalogMatch[]): string => canonical(matches.map(canonical).sort());

export function archiveReferenceIdentity(item: CanonicalReference): string {
  return canonical([item.bookId, item.brand, item.series, item.edition, item.model, item.iec, item.era]
    .map(value => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : value));
}

/** 调用方从同一只读事务取得原修订、最新快照和当前库存证据。 */
export function planCatalogHistoryRetention(input: {
  source: ReferenceSourceDetail;
  revision: CatalogRevision;
  snapshot: CatalogSnapshot;
  matches: readonly CatalogMatch[];
  matchVersion: number;
  referenceIds: readonly string[];
  currentInventoryEvidence: unknown;
}): CatalogHistoryRetention {
  const { source, revision, snapshot, matches, matchVersion, referenceIds, currentInventoryEvidence } = input;
  const invalid = (): never => { throw new CatalogRetentionError(); };
  if (!isReferenceSourceDetail(source) || source.source.id !== revision.sourceId || source.source.bookId !== revision.bookId
    || source.source.packHash !== revision.packHash || createHash('sha256').update(source.rawPack).digest('hex') !== revision.packHash
    || !isCatalogRevision(revision) || !isCatalogSnapshot(snapshot) || !Array.isArray(matches)
    || matches.length > MAX_CATALOG_MATCHES || !matches.every(isCatalogMatch)
    || !Number.isSafeInteger(matchVersion) || matchVersion < 0
    || snapshot.revisionId !== revision.id || snapshot.bookId !== revision.bookId || snapshot.matchVersion !== matchVersion
    || referenceIds.length === 0 || referenceIds.length > MAX_CATALOG_REFERENCES
    || new Set(referenceIds).size !== referenceIds.length) return invalid();
  const references = new Set(revision.items.map(item => item.referenceId));
  if (referenceIds.some(id => !references.has(id))
    || canonical(snapshot.entries.map(entry => entry.referenceId)) !== canonical(revision.items.map(item => item.referenceId))
    || matchFacts(snapshot.entries.flatMap(entry => entry.matches)) !== matchFacts(matches)) return invalid();
  const fingerprint = createHash('sha256').update(canonical({
    source, revision, snapshot, matches, matchVersion, referenceIds, currentInventoryEvidence,
  })).digest('hex');
  return { revisionId: revision.id, snapshotId: snapshot.id, matchVersion, referenceIds: [...referenceIds], fingerprint };
}
