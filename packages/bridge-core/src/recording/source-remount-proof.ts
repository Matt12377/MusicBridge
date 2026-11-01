import { createHash } from 'node:crypto';
import type { RootCapability } from './source-files.js';

interface SourceRemountProofFields {
  kind: 'smb-remount'; sourceRootId: string;
  previousDev: string; currentDev: string; rootIno: string;
  pathSha256: string; evidenceSha256: string;
}
/** 只由原 Core 的明确重新挂载恢复生成；Renderer 不提交根能力或此证明。 */
export interface SourceRemountProofV1 extends SourceRemountProofFields { version: 1 }
export interface SourceRemountProofV2 extends SourceRemountProofFields {
  version: 2; previousDevs: readonly string[]; mountSourceSha256: string;
}
export type SourceRemountProof = SourceRemountProofV1 | SourceRemountProofV2;
export const MAX_SOURCE_REMOUNT_PREVIOUS_DEVS = 64;
const number = /^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u;
const signature = /^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30}):(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30}):\d+:-?\d+:-?\d+$/u;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const pathHash = (value: string): string => createHash('sha256').update(value).digest('hex');
const fields = ['version', 'kind', 'sourceRootId', 'previousDev', 'currentDev', 'rootIno', 'pathSha256', 'evidenceSha256'] as const;
const v2Fields = [...fields, 'previousDevs', 'mountSourceSha256'] as const;
function previousDevices(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > MAX_SOURCE_REMOUNT_PREVIOUS_DEVS) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => descriptors[String(index)]).every(descriptor =>
      descriptor?.enumerable && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' && number.test(descriptor.value))
    && new Set(value).size === value.length;
}
export function isSourceRemountProof(value: unknown): value is SourceRemountProof {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const version = descriptors.version?.value, required = version === 2 ? v2Fields : fields;
  if (Reflect.ownKeys(descriptors).length !== required.length || required.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))) return false;
  const proof = value as SourceRemountProof;
  return (proof.version === 1 || proof.version === 2) && proof.kind === 'smb-remount'
    && typeof proof.sourceRootId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(proof.sourceRootId)
    && [proof.previousDev, proof.currentDev, proof.rootIno].every(v => typeof v === 'string' && number.test(v))
    && proof.previousDev !== proof.currentDev && sha(proof.pathSha256) && sha(proof.evidenceSha256)
    && (proof.version === 1 || previousDevices(proof.previousDevs) && proof.previousDevs[0] === proof.previousDev
      && !proof.previousDevs.includes(proof.currentDev) && sha(proof.mountSourceSha256));
}
export function sourceRemountProofMatchesRoot(root: RootCapability): boolean {
  if (!root || ![Object.prototype, null].includes(Object.getPrototypeOf(root))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(root);
  const rootFields = ['id', 'path', 'dev', 'ino', 'authorized', 'label', 'readonlyRemountProof'];
  if (Reflect.ownKeys(descriptors).length !== rootFields.length
    || rootFields.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))
    || typeof root.path !== 'string') return false;
  const proof = root.readonlyRemountProof;
  return isSourceRemountProof(proof) && root.authorized === true && proof.sourceRootId === root.id
    && proof.currentDev === root.dev && proof.rootIno === root.ino && proof.pathSha256 === pathHash(root.path);
}
/** 调用方必须先完成真实挂载与明确恢复授权；此函数只封装两份已捕获根的精确关系。 */
export function createSourceRemountProof(previous: RootCapability, current: RootCapability, evidenceSha256: string, mountSourceSha256?: string): SourceRemountProof {
  const prior = previous.readonlyRemountProof;
  if (!previous.authorized || !current.authorized || previous.id !== current.id || previous.path !== current.path
    || previous.ino !== current.ino || previous.label !== current.label || previous.dev === current.dev
    || prior !== undefined && !sourceRemountProofMatchesRoot(previous)) {
    throw new Error('重新挂载恢复不能替换原来源、路径、目录或损坏的既有证明。');
  }
  // 无来源摘要的旧调用只保留首次 v1 行为；续接必须由原 Owner 重新提交实际 SMB 来源证据。
  if (prior !== undefined && mountSourceSha256 === undefined
    || mountSourceSha256 !== undefined && !sha(mountSourceSha256)
    || prior?.version === 2 && prior.mountSourceSha256 !== mountSourceSha256) {
    throw new Error('重新挂载恢复必须保持已核验的同一共享盘来源。');
  }
  const common: SourceRemountProofFields = { kind: 'smb-remount', sourceRootId: current.id,
    previousDev: previous.dev, currentDev: current.dev, rootIno: current.ino,
    pathSha256: pathHash(current.path), evidenceSha256 };
  let proof: SourceRemountProof;
  if (mountSourceSha256 === undefined) proof = { version: 1, ...common };
  else {
    const devices = [...new Set([...(prior?.version === 2 ? prior.previousDevs : prior ? [prior.previousDev] : []), previous.dev])]
      .filter(device => device !== current.dev);
    proof = { version: 2, ...common, previousDev: devices[0]!, previousDevs: Object.freeze(devices), mountSourceSha256 };
  }
  if (!isSourceRemountProof(proof)) throw new Error('重新挂载恢复的物理关系或原证据摘要无效。');
  return Object.freeze(proof);
}
/** 仅普通播放及即时目录资格消费；历史签名不变，实际 FD 仍精确核验当前五字段。 */
export function sourcePlaybackExpectedSignature(root: RootCapability, expected: string): string | undefined {
  if (typeof expected !== 'string' || expected.length > 256 || !signature.test(expected)) return undefined;
  if (root.readonlyRemountProof === undefined) return expected;
  if (!sourceRemountProofMatchesRoot(root)) return undefined;
  const pieces = expected.split(':');
  const proof = root.readonlyRemountProof;
  if (proof.version === 1 ? pieces[0] === proof.previousDev : proof.previousDevs.includes(pieces[0]!)) pieces[0] = root.dev;
  return pieces.join(':');
}
