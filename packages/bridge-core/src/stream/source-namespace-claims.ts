import { lstat, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { physicalResourceLocks, type PhysicalResourceCoordinator, type PhysicalResourceGuard, type SourceNamespaceResource } from './physical-resource-locks.js';

/** 内部六字段root端口；实际授权仍必经自有描述符及真实根、祖先认证。 */
interface SourceNamespaceRootPort { id: string; path: string; dev: string; ino: string; authorized: boolean; label: string }

export type SourceNamespaceState = 'held' | 'released' | 'unverified';
export class SourceNamespaceCaptureError extends Error {
  constructor(readonly code: 'OUTSIDE_ROOT' | 'REVOKED' | 'SOURCE_ROOT_OFFLINE' | 'CONTENT_CHANGED' | 'IO_ERROR') { super(code); }
}
export class SourceNamespaceUnverified extends Error {
  constructor(readonly claims: SourceNamespaceReadClaims | SourceNamespaceWriteToken | SourceNamespaceRecoveryToken, cause?: unknown) {
    super('源命名位保护尚未核实，原保护继续保留。', { cause });
  }
}
export interface SourceNamespaceIdentity { readonly absolute: string; readonly resources: readonly SourceNamespaceResource[] }
export interface SourceNamespaceReadClaims { readonly state: SourceNamespaceState; retain(): void; release(): Promise<void> }
export interface SourceNamespaceOriginBinding {
  readonly datasetId: string; readonly originPlanId: string; readonly planHash: string; readonly contextFingerprint: string;
  readonly journalSequence: string; readonly projectionFingerprint: string;
}
export interface SourceNamespaceOperation { readonly operationId: string; readonly name: SourceNamespaceIdentity }
export interface SourceNamespaceWriteScope extends SourceNamespaceOriginBinding { readonly operations: readonly SourceNamespaceOperation[] }
export interface SourceNamespaceWriteToken {
  readonly binding: SourceNamespaceOriginBinding; readonly operationIds: readonly string[]; readonly state: SourceNamespaceState;
}
export interface SourceNamespaceRecoveryOperation extends SourceNamespaceOperation { readonly originOperationId: string }
export interface SourceNamespaceRecoveryScope {
  readonly datasetId: string; readonly originPlanId: string; readonly recoveryPlanId: string; readonly originBinding: SourceNamespaceOriginBinding;
  readonly operations: readonly SourceNamespaceRecoveryOperation[];
}
export interface SourceNamespaceRecoveryToken {
  /** originPlanId/originOperationIds 指直接品牌父代；rootOperationIds 是原计划映射。 */
  readonly binding: SourceNamespaceOriginBinding; readonly originPlanId: string; readonly recoveryPlanId: string; readonly operationIds: readonly string[];
  readonly originOperationIds: readonly string[]; readonly rootOperationIds: readonly string[]; readonly state: SourceNamespaceState;
}
export interface SourceNamespaceHeldScope {
  readonly datasetId: string; readonly planId: string; readonly originBinding: SourceNamespaceOriginBinding;
  readonly operations: readonly SourceNamespaceOperation[];
}
export interface SourceNamespaceHeldObservation {
  readonly token: SourceNamespaceWriteToken | SourceNamespaceRecoveryToken; readonly datasetId: string; readonly planId: string;
  readonly originBinding: SourceNamespaceOriginBinding; readonly operationId: string;
}

const identities = new WeakSet<object>();
interface Operation { names: Map<string, SourceNamespaceIdentity>; retained: boolean; released: boolean; releasing: boolean; delegate: Recovery | null }
interface Write { token: SourceNamespaceWriteToken; binding: SourceNamespaceOriginBinding; operations: Map<string, Operation>; guards: Map<string, PhysicalResourceGuard>; coordinator: PhysicalResourceCoordinator; fatal: boolean; recoveries: Recovery[] }
interface Recovery { token: SourceNamespaceRecoveryToken; write: Write; planId: string; parent: Recovery | null; operations: readonly SourceNamespaceRecoveryOperation[]; own: Map<string, Operation>; immediate: Map<string, string> }
const writes = new WeakMap<object, Write>(), recoveries = new WeakMap<object, Recovery>();
const invalid = (): never => { throw new Error('源命名位保护缺少真实身份或精确绑定。'); };
const resourceId = (value: SourceNamespaceResource): string => `${value.dev}\0${value.absolute}`;
const isId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** 仅复制自有数据描述符；未捕获的 getter、symbol、稀疏数组和原型不能授予内部能力。 */
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input), own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) return invalid();
    const value: Record<string, unknown> = Object.create(null);
    for (const key of keys) { const d = descriptors[key]; if (!d || !('value' in d) || !d.enumerable) return invalid(); value[key] = d.value; }
    return value;
  } catch { return invalid(); }
}
function array(input: unknown, maximum: number): readonly unknown[] {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<string, PropertyDescriptor>, length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > maximum || Reflect.ownKeys(descriptors).length !== Number(length) + 1) return invalid();
    const result: unknown[] = [];
    for (let at = 0; at < Number(length); at++) { const d = descriptors[String(at)]; if (!d || !('value' in d) || !d.enumerable) return invalid(); result.push(d.value); }
    return result;
  } catch { return invalid(); }
}
function binding(input: unknown): SourceNamespaceOriginBinding {
  const value = record(input, ['datasetId', 'originPlanId', 'planHash', 'contextFingerprint', 'journalSequence', 'projectionFingerprint']);
  if (!isId(value.datasetId) || !isId(value.originPlanId) || !isHash(value.planHash) || !isHash(value.contextFingerprint) || !isHash(value.projectionFingerprint)
    || typeof value.journalSequence !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(value.journalSequence) || BigInt(value.journalSequence) > 18446744073709551615n) return invalid();
  return Object.freeze(value) as unknown as SourceNamespaceOriginBinding;
}
function sameBinding(actual: SourceNamespaceOriginBinding, expected: SourceNamespaceOriginBinding): boolean {
  return actual.datasetId === expected.datasetId && actual.originPlanId === expected.originPlanId && actual.planHash === expected.planHash
    && actual.contextFingerprint === expected.contextFingerprint && actual.journalSequence === expected.journalSequence && actual.projectionFingerprint === expected.projectionFingerprint;
}
function name(input: unknown): SourceNamespaceIdentity { if (!input || typeof input !== 'object' || !identities.has(input)) return invalid(); return input as SourceNamespaceIdentity; }
function operations(input: unknown, recovery = false): readonly SourceNamespaceRecoveryOperation[] {
  const seen = new Set<string>(), selected = array(input, 2048).map(raw => {
    const value = record(raw, recovery ? ['operationId', 'originOperationId', 'name'] : ['operationId', 'name']);
    if (!isId(value.operationId) || recovery && !isId(value.originOperationId)) return invalid();
    const named = name(value.name), originOperationId = recovery ? value.originOperationId as string : value.operationId;
    const key = `${value.operationId}\0${named.absolute}`; if (seen.has(key)) return invalid(); seen.add(key);
    return Object.freeze({ operationId: value.operationId, originOperationId, name: named });
  });
  if (new Set(selected.map(v => v.operationId)).size > 100) return invalid();
  return Object.freeze(selected);
}
function resources(names: readonly SourceNamespaceIdentity[]): readonly SourceNamespaceResource[] {
  const selected = new Map<string, SourceNamespaceResource>();
  for (const named of names) for (const value of name(named).resources) selected.set(resourceId(value), value);
  if (!selected.size || selected.size > 2048) return invalid();
  return [...selected.values()].sort((a, b) => resourceId(a) < resourceId(b) ? -1 : resourceId(a) > resourceId(b) ? 1 : 0);
}
function sameName(actual: SourceNamespaceIdentity, expected: SourceNamespaceIdentity): boolean {
  return actual.absolute === expected.absolute && actual.resources.length === expected.resources.length
    && actual.resources.every(v => expected.resources.some(e => resourceId(v) === resourceId(e)));
}

/** 目标可以暂缺；根和全部祖先必须真实、无符号链接且仍匹配服务器授权。 */
export async function captureSourceNamespace(root: SourceNamespaceRootPort, relative: string): Promise<SourceNamespaceIdentity> {
  let value: Record<string, unknown>;
  try { value = record(root, ['id', 'path', 'dev', 'ino', 'authorized', 'label']); } catch { throw new SourceNamespaceCaptureError('OUTSIDE_ROOT'); }
  if (value.authorized !== true) throw new SourceNamespaceCaptureError('REVOKED');
  if (!isId(value.id) || typeof value.label !== 'string' || typeof value.path !== 'string' || value.path.length > 4096 || value.path.includes('\0')
    || !path.isAbsolute(value.path) || path.resolve(value.path) !== value.path || value.path === path.parse(value.path).root
    || typeof value.dev !== 'string' || typeof value.ino !== 'string' || !/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u.test(value.dev) || !/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u.test(value.ino)
    || typeof relative !== 'string' || !relative || relative.length > 4096 || relative.includes('\0') || path.isAbsolute(relative)
    || relative.split(path.sep).some(p => !p || p === '.' || p === '..')) throw new SourceNamespaceCaptureError('OUTSIDE_ROOT');
  const rootPath = value.path, absolute = path.join(rootPath, relative), parts = relative.split(path.sep).slice(0, -1);
  const ancestors: { absolute: string; info: BigIntStats }[] = [];
  let cursor = rootPath;
  try {
    for (let at = 0; at <= parts.length; at++) {
      if (at) cursor = path.join(cursor, parts[at - 1]!);
      const info = await lstat(cursor, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(cursor) !== cursor) throw new SourceNamespaceCaptureError(at ? 'OUTSIDE_ROOT' : 'SOURCE_ROOT_OFFLINE');
      if (!at && (String(info.dev) !== value.dev || String(info.ino) !== value.ino)) throw new SourceNamespaceCaptureError('SOURCE_ROOT_OFFLINE');
      ancestors.push({ absolute: cursor, info });
    }
    for (const before of ancestors) {
      const actual = await lstat(before.absolute, { bigint: true });
      if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== before.info.dev || actual.ino !== before.info.ino || actual.birthtimeNs !== before.info.birthtimeNs
        || await realpath(before.absolute) !== before.absolute) throw new SourceNamespaceCaptureError('CONTENT_CHANGED');
    }
  } catch (error) {
    if (error instanceof SourceNamespaceCaptureError) throw error;
    throw new SourceNamespaceCaptureError(ancestors.length ? 'IO_ERROR' : 'SOURCE_ROOT_OFFLINE');
  }
  // 根卷锚点保留路径缺口；真实父卷锚点使跨挂载点的嵌套根仍有共同 key。
  const values = [...new Set([String(ancestors[0]!.info.dev), String(ancestors[ancestors.length - 1]!.info.dev)])]
    .map(dev => Object.freeze({ dev, absolute }));
  const identity = Object.freeze({ absolute, resources: Object.freeze(values) }); identities.add(identity); return identity;
}

export async function acquireSourceNamespaceRead(names: readonly SourceNamespaceIdentity[], coordinator: PhysicalResourceCoordinator = physicalResourceLocks): Promise<SourceNamespaceReadClaims> {
  const selected = resources(array(names, 2048).map(name)), guards: PhysicalResourceGuard[] = [];
  let state: SourceNamespaceState = 'held', releasing: Promise<void> | undefined;
  const claims: SourceNamespaceReadClaims = Object.freeze({ get state() { return state; }, retain() { if (state === 'released') return invalid(); state = 'unverified'; }, release() {
    if (state === 'unverified') return Promise.reject(new SourceNamespaceUnverified(claims));
    return releasing ??= (async () => { try { await coordinator.releaseSourceNamespaceGuards(guards); state = 'released'; } catch (error) { state = 'unverified'; throw new SourceNamespaceUnverified(claims, error); } })();
  } });
  try { for (let at = 0; at < selected.length; at += 128) guards.push(coordinator.acquireSourceNamespaceRead(selected.slice(at, at + 128))); return claims; }
  catch (error) { await claims.release(); throw error; }
}

function writeState(write: Write): SourceNamespaceState {
  const entries = [...write.operations.values(), ...write.recoveries.flatMap(v => [...v.own.values()])];
  return entries.every(v => v.released) ? 'released' : write.fatal || entries.some(v => !v.released && (v.retained || v.releasing)) ? 'unverified' : 'held';
}
export async function acquireSourceNamespaceWrite(scope: SourceNamespaceWriteScope, coordinator: PhysicalResourceCoordinator = physicalResourceLocks): Promise<SourceNamespaceWriteToken> {
  const captured = record(scope, ['datasetId', 'originPlanId', 'planHash', 'contextFingerprint', 'journalSequence', 'projectionFingerprint', 'operations']);
  const { operations: raw, ...metadata } = captured, origin = binding(metadata), selected = operations(raw), all = resources(selected.map(v => v.name));
  const grouped = new Map<string, Operation>();
  for (const item of selected) { const entry = grouped.get(item.operationId) ?? { names: new Map(), retained: false, released: false, releasing: false, delegate: null }; entry.names.set(item.name.absolute, item.name); grouped.set(item.operationId, entry); }
  let write: Write;
  const token: SourceNamespaceWriteToken = Object.freeze({ binding: origin, operationIds: Object.freeze([...grouped.keys()]), get state() { return writeState(write); } });
  write = { token, binding: origin, operations: grouped, guards: new Map(), coordinator, fatal: false, recoveries: [] }; writes.set(token, write);
  try {
    // 独立 guard 允许逐项收口，最终 release 在同一原子事务内验证并释放全部选定 key。
    for (let at = 0; at < all.length; at += 128) for (const value of all.slice(at, at + 128)) write.guards.set(resourceId(value), coordinator.acquireSourceNamespaceWrite([value]));
    return token;
  } catch (error) {
    try { await coordinator.releaseSourceNamespaceGuards([...write.guards.values()]); for (const entry of grouped.values()) entry.released = true; }
    catch (releaseError) { write.fatal = true; throw new SourceNamespaceUnverified(token, releaseError); }
    throw error;
  }
}
function write(input: unknown): Write { if (!input || typeof input !== 'object') return invalid(); return writes.get(input) ?? invalid(); }
function recovery(input: unknown): Recovery { if (!input || typeof input !== 'object') return invalid(); return recoveries.get(input) ?? invalid(); }
function selectedIds(input: unknown, allowed: readonly string[]): readonly string[] {
  const values = array(input, 100); if (values.some(v => !isId(v) || !allowed.includes(v)) || new Set(values).size !== values.length) return invalid(); return values as string[];
}
export function retainSourceNamespaceWrite(token: SourceNamespaceWriteToken | SourceNamespaceRecoveryToken, operationIds?: readonly string[]): void {
  const delegated = token && typeof token === 'object' ? recoveries.get(token) : undefined, held = delegated?.write ?? write(token), entries = delegated?.own ?? held.operations;
  for (const id of selectedIds(operationIds ?? [...entries.keys()], [...entries.keys()])) { const entry = entries.get(id)!; if (entry.released || entry.releasing) return invalid(); entry.retained = true; }
}
export function assertSourceNamespaceHeld(token: SourceNamespaceWriteToken | SourceNamespaceRecoveryToken, scope: SourceNamespaceHeldScope): void {
  const captured = record(scope, ['datasetId', 'planId', 'originBinding', 'operations']), origin = binding(captured.originBinding), requested = operations(captured.operations);
  const delegated = token && typeof token === 'object' ? recoveries.get(token) : undefined, held = delegated?.write ?? write(token);
  if (held.fatal || captured.datasetId !== held.binding.datasetId || !sameBinding(held.binding, origin) || captured.planId !== (delegated?.planId ?? held.binding.originPlanId)) return invalid();
  const ancestors = new Set<Recovery>(); for (let cursor = delegated?.parent; cursor; cursor = cursor.parent) ancestors.add(cursor);
  for (const item of requested) {
    const entry = (delegated?.own ?? held.operations).get(item.operationId), named = entry?.names.get(item.name.absolute);
    if (!entry || entry.released || entry.releasing || !named || !sameName(named, item.name) || entry.delegate && entry.delegate !== delegated) return invalid();
    // 中间父代已 resolved 时，尚未收口的后代仍是该命名位的唯一借用者。
    if (held.recoveries.some(value => value !== delegated && !ancestors.has(value)
      && [...value.own.values()].some(other => !other.released && other.names.has(item.name.absolute)))) return invalid();
  }
}
export function delegateSourceNamespaceRecovery(token: SourceNamespaceWriteToken | SourceNamespaceRecoveryToken, scope: SourceNamespaceRecoveryScope): SourceNamespaceRecoveryToken {
  const parent = token && typeof token === 'object' ? recoveries.get(token) : undefined, held = parent?.write ?? write(token), parentOperations = parent?.own ?? held.operations;
  const captured = record(scope, ['datasetId', 'originPlanId', 'recoveryPlanId', 'originBinding', 'operations']), origin = binding(captured.originBinding), selected = operations(captured.operations, true);
  if (held.fatal || captured.datasetId !== held.binding.datasetId || captured.originPlanId !== (parent?.planId ?? held.binding.originPlanId) || !isId(captured.recoveryPlanId)
    || captured.recoveryPlanId === held.binding.originPlanId || held.recoveries.some(v => v.planId === captured.recoveryPlanId) || !sameBinding(held.binding, origin)) return invalid();
  const groups = new Map<string, { operationId: string; names: Map<string, SourceNamespaceIdentity> }>();
  for (const item of selected) {
    const entry = parentOperations.get(item.originOperationId), original = entry?.names.get(item.name.absolute);
    if (!entry || entry.released || entry.releasing || entry.delegate || parent && !entry.retained || !original || !sameName(original, item.name)) return invalid();
    const group = groups.get(item.originOperationId) ?? { operationId: item.operationId, names: new Map() };
    if (group.operationId !== item.operationId) return invalid(); group.names.set(item.name.absolute, item.name); groups.set(item.originOperationId, group);
  }
  if (new Set([...groups.values()].map(v => v.operationId)).size !== groups.size) return invalid();
  for (const [id, group] of groups) if (group.names.size !== parentOperations.get(id)!.names.size) return invalid();
  const ancestors = new Set<Recovery>(); for (let cursor = parent; cursor; cursor = cursor.parent ?? undefined) ancestors.add(cursor);
  const requestedNames = new Set(selected.map(v => v.name.absolute));
  if (held.recoveries.some(v => !ancestors.has(v) && [...v.own.values()].some(entry => !entry.released && [...entry.names.keys()].some(named => requestedNames.has(named))))) return invalid();
  const rootOperations = selected.map(item => {
    const root = parent?.operations.find(v => v.operationId === item.originOperationId && sameName(v.name, item.name));
    if (parent && !root) return invalid();
    return Object.freeze({ operationId: item.operationId, originOperationId: root?.originOperationId ?? item.originOperationId, name: item.name });
  });
  const own = new Map<string, Operation>(); for (const item of selected) {
    const entry = own.get(item.operationId) ?? { names: new Map(), retained: false, released: false, releasing: false, delegate: null };
    entry.names.set(item.name.absolute, item.name); own.set(item.operationId, entry);
  }
  let delegated: Recovery;
  const result: SourceNamespaceRecoveryToken = Object.freeze({ binding: held.binding, originPlanId: captured.originPlanId as string, recoveryPlanId: captured.recoveryPlanId,
    operationIds: Object.freeze([...groups.values()].map(v => v.operationId)), originOperationIds: Object.freeze([...groups.keys()]),
    rootOperationIds: Object.freeze([...new Set(rootOperations.map(v => v.originOperationId))]),
    get state(): SourceNamespaceState { return [...own.values()].every(v => v.released) ? 'released' : held.fatal || [...own.values()].some(v => v.retained || v.releasing) ? 'unverified' : 'held'; } });
  delegated = { token: result, write: held, planId: captured.recoveryPlanId, parent: parent ?? null, operations: Object.freeze(rootOperations), own,
    immediate: new Map(selected.map(v => [v.operationId, v.originOperationId])) }; recoveries.set(result, delegated); held.recoveries.push(delegated);
  for (const id of groups.keys()) parentOperations.get(id)!.delegate = delegated;
  return result;
}
export function sourceNamespaceRecoveryBindings(token: SourceNamespaceRecoveryToken): readonly SourceNamespaceRecoveryOperation[] { return recovery(token).operations; }

async function releaseOperations(held: Write, ids: readonly string[], delegated?: Recovery, resolvedOrigin = false): Promise<void> {
  if (held.fatal) throw new SourceNamespaceUnverified(delegated?.token ?? held.token);
  const allEntries = [...held.operations.values(), ...held.recoveries.flatMap(v => [...v.own.values()])], source = delegated?.own ?? held.operations;
  const entries = ids.map(id => source.get(id) ?? invalid());
  if (allEntries.some(entry => entry.releasing) || entries.some(entry => entry.released || (!delegated && !resolvedOrigin && (entry.retained || entry.delegate !== null)))) return invalid();
  const selected = new Set(entries), remaining = new Set<string>();
  for (const entry of allEntries) if (!entry.released && !selected.has(entry)) for (const named of entry.names.values()) for (const value of named.resources) remaining.add(resourceId(value));
  const keys = new Set<string>(); for (const entry of entries) for (const named of entry.names.values()) for (const value of named.resources) if (!remaining.has(resourceId(value))) keys.add(resourceId(value));
  for (const entry of entries) entry.releasing = true;
  try {
    await held.coordinator.releaseSourceNamespaceGuards([...keys].map(key => held.guards.get(key) ?? invalid()));
    for (const key of keys) held.guards.delete(key);
    for (const entry of entries) { entry.released = true; entry.releasing = false; }
    if (delegated) {
      const parentOperations = delegated.parent?.own ?? held.operations;
      for (const id of ids) { const parent = parentOperations.get(delegated.immediate.get(id)!); if (parent?.delegate === delegated) parent.delegate = null; }
    }
  } catch (error) { held.fatal = true; for (const entry of entries) { entry.releasing = false; entry.retained = true; } throw new SourceNamespaceUnverified(delegated?.token ?? held.token, error); }
}
/** 仅正常写者真实 FD quiet、QUIET 持久化后由 Owner 调用；unknown 项必须经品牌恢复委托。 */
export async function releaseSourceNamespaceWrite(token: SourceNamespaceWriteToken, operationIds: readonly string[]): Promise<void> {
  const held = write(token); await releaseOperations(held, selectedIds(operationIds, token.operationIds));
}
/** 不执行文件 I/O；Core 先证明真实 quiet 与该代 durable resolved，仅消该委托自己的义务。 */
export async function resolveSourceNamespaceRecovery(token: SourceNamespaceRecoveryToken, operationIds: readonly string[]): Promise<void> {
  const delegated = recovery(token); await releaseOperations(delegated.write, selectedIds(operationIds, token.operationIds), delegated);
}
/** 原发布义务有独立持久 resolved；子恢复成功不能自动推定祖先义务已消除。 */
export async function resolveSourceNamespaceOrigin(token: SourceNamespaceWriteToken, operationIds: readonly string[]): Promise<void> {
  const held = write(token); await releaseOperations(held, selectedIds(operationIds, token.operationIds), undefined, true);
}
