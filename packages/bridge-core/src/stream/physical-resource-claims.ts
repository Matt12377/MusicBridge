import { physicalResourceLocks, type PhysicalResourceCoordinator, type PhysicalResource, type PhysicalResourceGuard } from './physical-resource-locks.js';

export type PhysicalClaimsState = 'held' | 'released' | 'unverified';
/** 保留原协调器的 guards；错误不是已经释放的证据。 */
export class PhysicalClaimsUnverified extends Error {
  constructor(readonly claims: PhysicalReadClaims, readonly reason: 'RELEASE_UNVERIFIED' | 'COMMIT_UNVERIFIED', cause?: unknown) {
    super('物理保护结果尚未核实，原保护保留，禁止继续准入。', { cause });
  }
}
export interface PhysicalReadClaims {
  readonly resources: readonly PhysicalResource[];
  readonly state: PhysicalClaimsState;
  retain(): void;
  release(): Promise<void>;
}

/** 一次最多原有 2048 槽；128 是 acquire 调用上限，不是旧母版曲数上限。 */
export async function acquirePhysicalReadClaims(resources: readonly PhysicalResource[], coordinator: PhysicalResourceCoordinator = physicalResourceLocks): Promise<PhysicalReadClaims> {
  if (!Array.isArray(resources) || !resources.length || resources.length > 2048) throw new Error('物理保护集合无效或超过原容量。');
  const unique = new Map<string, PhysicalResource>();
  for (const resource of resources) {
    if (!resource || typeof resource.dev !== 'string' || typeof resource.ino !== 'string' || !/^\d{1,32}$/u.test(resource.dev) || !/^\d{1,32}$/u.test(resource.ino)) throw new Error('物理保护身份无效。');
    const normalized = { dev: BigInt(resource.dev).toString(), ino: BigInt(resource.ino).toString() };
    unique.set(`${normalized.dev}:${normalized.ino}`, normalized);
  }
  const selected = [...unique.values()].sort((a, b) => BigInt(a.dev) < BigInt(b.dev) ? -1 : BigInt(a.dev) > BigInt(b.dev) ? 1 : BigInt(a.ino) < BigInt(b.ino) ? -1 : BigInt(a.ino) > BigInt(b.ino) ? 1 : 0);
  const guards: { guard: PhysicalResourceGuard; released: boolean }[] = [];
  let state: PhysicalClaimsState = 'held', releasing: Promise<void> | undefined;
  const claims: PhysicalReadClaims = {
    resources: selected,
    get state() { return state; },
    retain() { if(state==='released')throw new Error('已核释放的claim不能伪变为仍持有。');state = 'unverified'; },
    release() {
      if (releasing) return releasing;
      if (state === 'unverified') return Promise.reject(new PhysicalClaimsUnverified(claims, 'COMMIT_UNVERIFIED'));
      releasing = (async () => {
        let failed = false, cause: unknown;
        for (const entry of [...guards].reverse()) {
          if (entry.released) continue;
          try { await entry.guard.release(); entry.released = true; }
          catch (error) { failed = true; cause ??= error; }
        }
        if (failed) { state = 'unverified'; throw new PhysicalClaimsUnverified(claims, 'RELEASE_UNVERIFIED', cause); }
        state = 'released';
      })();
      return releasing;
    },
  };
  try {
    for (let offset = 0; offset < selected.length; offset += 128) guards.push({ guard: coordinator.acquireRead(selected.slice(offset, offset + 128)), released: false });
    return claims;
  } catch (error) {
    await claims.release();
    throw error;
  }
}
