import { createHash } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';

const SLOTS = 2048, WORDS_PER_SLOT = 4;
export const PHYSICAL_RESOURCE_BUFFER_BYTES = (1 + SLOTS * WORDS_PER_SLOT) * 4;
export interface PhysicalResource { dev: string; ino: string }
export class PhysicalResourceBusy extends Error { constructor() { super('物理资源正被读取或独占，操作需要延期。'); } }
export interface PhysicalResourceGuard { release(): Promise<void> }
/** 同一 Core 与其 Owner Worker 共享原子表；不按逻辑 asset/root 标识加锁。 */
export class PhysicalResourceCoordinator {
  readonly buffer: SharedArrayBuffer;
  private readonly words: Int32Array;
  constructor(buffer: SharedArrayBuffer = new SharedArrayBuffer(PHYSICAL_RESOURCE_BUFFER_BYTES)) {
    if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== PHYSICAL_RESOURCE_BUFFER_BYTES) throw new Error('物理资源协调器共享身份无效。');
    this.buffer = buffer; this.words = new Int32Array(buffer);
  }
  private transaction<T>(run: () => T): T {
    if (Atomics.compareExchange(this.words, 0, 0, 1) !== 0) throw new PhysicalResourceBusy();
    try { return run(); } finally { Atomics.store(this.words, 0, 0); }
  }
  private key(resource: PhysicalResource): number[] {
    if (!/^\d{1,32}$/u.test(resource.dev) || !/^\d{1,32}$/u.test(resource.ino)) throw new Error('物理资源身份无效。');
    const digest = createHash('sha256').update(`${BigInt(resource.dev)}:${BigInt(resource.ino)}`).digest();
    // 摘要碰撞只会保守地协调无关文件，不会绕过实际 dev/ino 的保护。
    return [digest.readInt32LE(0), digest.readInt32LE(4), digest.readInt32LE(8)];
  }
  private acquire(resources: readonly PhysicalResource[], mode: 'read' | 'write'): PhysicalResourceGuard {
    if (!resources.length || resources.length > 128) throw new Error('物理资源集合须有界且非空。');
    const keys = [...new Map(resources.map(resource => { const key = this.key(resource); return [key.join(':'), key] as const; })).values()];
    const slots = this.transaction(() => {
      const selected: number[] = [], reserved = new Set<number>();
      for (const key of keys) {
        let found = -1, empty = -1;
        for (let slot = 0; slot < SLOTS; slot++) {
          const offset = 1 + slot * WORDS_PER_SLOT, count = Atomics.load(this.words, offset + 3);
          if (count === 0 && empty < 0 && !reserved.has(offset)) empty = offset;
          if (count !== 0 && key.every((word, i) => Atomics.load(this.words, offset + i) === word)) { found = offset; break; }
        }
        if (found >= 0 && (mode === 'write' || Atomics.load(this.words, found + 3) < 0)) throw new PhysicalResourceBusy();
        const offset = found >= 0 ? found : empty;
        if (offset < 0 || Atomics.load(this.words, offset + 3) >= 65535) throw new PhysicalResourceBusy();
        selected.push(offset); reserved.add(offset);
      }
      for (let i = 0; i < selected.length; i++) {
        const offset = selected[i]!; keys[i]!.forEach((word, n) => Atomics.store(this.words, offset + n, word));
        Atomics.store(this.words, offset + 3, mode === 'write' ? -1 : Atomics.load(this.words, offset + 3) + 1);
      }
      return selected;
    });
    let released = false, releasing: Promise<void> | undefined;
    return { release: () => releasing ??= (async () => {
      if (released) return;
      // 释放只在调用者已 join I/O/关闭FD 后请求；短暂竞争异步让出，不阻塞UI。
      for (let attempt = 0; attempt < 1000; attempt++) {
        try { this.transaction(() => { for (const offset of slots) { const value = Atomics.load(this.words, offset + 3); if (value === 0 || mode === 'write' && value !== -1) throw new Error('物理保护租约不一致。'); Atomics.store(this.words, offset + 3, mode === 'write' ? 0 : value - 1); } }); released = true; return; }
        catch (error) { if (!(error instanceof PhysicalResourceBusy)) throw error; await immediate(); }
      }
      throw new Error('物理资源释放未确认，保护继续保留。');
    })() };
  }
  acquireRead(resources: readonly PhysicalResource[]): PhysicalResourceGuard { return this.acquire(resources, 'read'); }
  acquireWrite(resources: readonly PhysicalResource[]): PhysicalResourceGuard { return this.acquire(resources, 'write'); }
  snapshot(): { readers: number; writers: number; resources: number } {
    return this.transaction(() => { let readers = 0, writers = 0, resources = 0; for (let slot = 0; slot < SLOTS; slot++) { const count = Atomics.load(this.words, 1 + slot * WORDS_PER_SLOT + 3); if (count !== 0) resources++; if (count > 0) readers += count; if (count < 0) writers++; } return { readers, writers, resources }; });
  }
}
export let physicalResourceLocks = new PhysicalResourceCoordinator();
/** 仅可信启动组合调用，不能经Renderer或环境设置共享表。 */
export function installPhysicalResourceCoordinator(buffer: SharedArrayBuffer): void {
  const counts = physicalResourceLocks.snapshot(); if (counts.resources) throw new Error('活动物理保护期间不能替换协调器。');
  physicalResourceLocks = new PhysicalResourceCoordinator(buffer);
}
