import { createHash } from 'node:crypto';
import type { RootCapability } from './source-files.js';

/** 只由原 Core 的明确重新挂载恢复生成；Renderer 不提交根能力或此证明。 */
export interface SourceRemountProof {
  version: 1; kind: 'smb-remount'; sourceRootId: string;
  previousDev: string; currentDev: string; rootIno: string;
  pathSha256: string; evidenceSha256: string;
}
const number = /^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u;
const signature = /^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30}):(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30}):\d+:-?\d+:-?\d+$/u;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const pathHash = (value: string): string => createHash('sha256').update(value).digest('hex');
const fields = ['version', 'kind', 'sourceRootId', 'previousDev', 'currentDev', 'rootIno', 'pathSha256', 'evidenceSha256'] as const;
export function isSourceRemountProof(value: unknown): value is SourceRemountProof {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))) return false;
  const proof = value as SourceRemountProof;
  return proof.version === 1 && proof.kind === 'smb-remount'
    && typeof proof.sourceRootId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(proof.sourceRootId)
    && [proof.previousDev, proof.currentDev, proof.rootIno].every(v => typeof v === 'string' && number.test(v))
    && proof.previousDev !== proof.currentDev && sha(proof.pathSha256) && sha(proof.evidenceSha256);
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
export function createSourceRemountProof(previous: RootCapability, current: RootCapability, evidenceSha256: string): SourceRemountProof {
  if (!previous.authorized || !current.authorized || previous.id !== current.id || previous.path !== current.path
    || previous.ino !== current.ino || previous.label !== current.label || previous.readonlyRemountProof !== undefined) {
    throw new Error('重新挂载恢复不能替换原来源、路径、目录或既有证明。');
  }
  const proof: SourceRemountProof = { version: 1, kind: 'smb-remount', sourceRootId: current.id,
    previousDev: previous.dev, currentDev: current.dev, rootIno: current.ino,
    pathSha256: pathHash(current.path), evidenceSha256 };
  if (!isSourceRemountProof(proof)) throw new Error('重新挂载恢复的物理关系或原证据摘要无效。');
  return Object.freeze(proof);
}
/** 仅普通播放及即时目录资格消费；历史签名不变，实际 FD 仍精确核验当前五字段。 */
export function sourcePlaybackExpectedSignature(root: RootCapability, expected: string): string | undefined {
  if (typeof expected !== 'string' || expected.length > 256 || !signature.test(expected)) return undefined;
  if (root.readonlyRemountProof === undefined) return expected;
  if (!sourceRemountProofMatchesRoot(root)) return undefined;
  const pieces = expected.split(':');
  if (pieces[0] === root.readonlyRemountProof.previousDev) pieces[0] = root.dev;
  return pieces.join(':');
}
