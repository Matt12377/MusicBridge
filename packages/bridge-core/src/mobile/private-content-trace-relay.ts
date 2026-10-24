import { createCatalogTraceRelay } from './catalog-private-trace.js';
import { types } from 'node:util';
import { copyMobileCapabilityTraceRecord, MOBILE_CAPABILITY_TRACE_PREFIX, MOBILE_RESOURCE_CAPACITY_STAGES, type MobileCapabilityTraceRecord } from './capability-trace.js';

export const MOBILE_COLLECTION_TRACE_PREFIX = 'MUSICBRIDGE_MOBILE_COLLECTION_TRACE ';
const fields = ['schema','requestSha256','epochMs','stage','baselinePresent','expectedPresent','revisionEqual',
  'accountDomainEqual','ownerEpochEqual','providerEpochEqual','collectionIdEqual','trackIdsEqual','titleEqual',
  'artworkIdentityEqual','updateTimeEqual','firstOffset','offset'] as const;
const comparisons = fields.slice(6,15);
const offset = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;

/** 只拷贝固定数据属性；未知字段、代理/getter和素材身份一律整行丢弃。 */
export function copyMobileCollectionTraceRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (!raw || typeof raw !== 'object' || types.isProxy(raw) || ![Object.prototype,null].includes(Object.getPrototypeOf(raw))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(descriptors).length !== fields.length || !fields.every(key => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'))) return null;
    const value = Object.fromEntries(fields.map(key => [key, descriptors[key]!.value]));
    if (value.schema !== 'mb.mobile-collection-trace.v1' || value.stage !== 'liked.revision.compare'
      || typeof value.requestSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.requestSha256)
      || !Number.isSafeInteger(value.epochMs) || Number(value.epochMs) < 0
      || typeof value.baselinePresent !== 'boolean' || typeof value.expectedPresent !== 'boolean'
      || !comparisons.every(key => value[key] === null || typeof value[key] === 'boolean')
      || value.firstOffset !== null && !offset(value.firstOffset) || !offset(value.offset)) return null;
    return Object.freeze(value);
  } catch { return null; }
}

/** 每个原Core child独立预算；默认关闭，不引入任务/请求或转发任意stdout。 */
export function createMobilePrivateContentTraceRelay(options: { enabled: boolean; sink(line: string): void }) {
  let partial = '', discarding = false, collectionCount = 0, collectionBytes = 0, capabilityCount = 0;
  const firstFailures = new Set<string>();
  const capacityFailures = new Set<string>(), capacityStages = new Set<string>(MOBILE_RESOURCE_CAPACITY_STAGES);
  const catalog = createCatalogTraceRelay(options.enabled, line => send(line));
  function send(line: string): void { try { options.sink(line); } catch { /* 诊断出口失败不影响原Core或业务。 */ } }
  return {
    registerCatalog: catalog.register,
    catalog: catalog.feed,
    capability(raw: MobileCapabilityTraceRecord): void {
      if (!options.enabled) return;
      const row = copyMobileCapabilityTraceRecord(raw); if (!row || row.component === 'main') return;
      // 显式容量窗口的首拒不借用已被发现/封面耗尽的通用首错槽；仍最多128个哈希请求。
      if (row.phase === 'reject' && capacityStages.has(row.stage)) {
        const key = `${row.component}:${row.requestSha256}:${row.role}`;
        if (capacityFailures.has(key) || capacityFailures.size >= 128) return;
        capacityFailures.add(key); send(MOBILE_CAPABILITY_TRACE_PREFIX + JSON.stringify(row) + '\n'); return;
      }
      // 常规最多2048行，另为128个请求/角色的首拒留位；后来的普通行不能挤掉首错。
      const key = `${row.component}:${row.requestSha256}:${row.role}`;
      if (row.phase === 'reject' && !firstFailures.has(key) && firstFailures.size < 128) firstFailures.add(key);
      else { if (capabilityCount >= 2048) return; capabilityCount++; }
      send(MOBILE_CAPABILITY_TRACE_PREFIX + JSON.stringify(row) + '\n');
    },
    collection(chunk: string): void {
      if (!options.enabled || collectionCount >= 64 || collectionBytes >= 64 * 1024) return;
      try {
        if (typeof chunk !== 'string' || chunk.length > 1024 * 1024) { partial = ''; discarding = true; return; }
        let at = 0;
        while (at < chunk.length) {
          const newline = chunk.indexOf('\n', at), end = newline < 0 ? chunk.length : newline;
          const segment = chunk.slice(at, end);
          if (!discarding) {
            if (Buffer.byteLength(partial) + Buffer.byteLength(segment) > 4096) { partial = ''; discarding = true; }
            else partial += segment;
          }
          if (newline < 0) return;
          if (!discarding && partial.startsWith(MOBILE_COLLECTION_TRACE_PREFIX)) {
            try {
              const record = copyMobileCollectionTraceRecord(JSON.parse(partial.slice(MOBILE_COLLECTION_TRACE_PREFIX.length)));
              if (record) {
                const line = MOBILE_COLLECTION_TRACE_PREFIX + JSON.stringify(record) + '\n', bytes = Buffer.byteLength(line);
                if (collectionCount < 64 && collectionBytes + bytes <= 64 * 1024) { collectionCount++; collectionBytes += bytes; send(line); }
              }
            } catch { /* 坏行只丢本行，后续闭集行仍能接收。 */ }
          }
          partial = ''; discarding = false; at = newline + 1;
        }
      } catch { partial = ''; discarding = false; }
    },
  };
}
