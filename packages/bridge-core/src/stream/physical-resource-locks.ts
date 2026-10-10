import { createHash } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import path from 'node:path';

const SLOTS = 2048, WORDS_PER_SLOT = 4;
// 原物理计数/摘要/SAB布局保持；命名位占同一容量，使用旧计数范围外的独立域。
const MAX_READERS = 65535, NAMESPACE_READ_BASE = 65536, NAMESPACE_WRITE = -2;
const namespaceReadCount = (count:number):boolean => count > NAMESPACE_READ_BASE && count <= NAMESPACE_READ_BASE + MAX_READERS;
export const PHYSICAL_RESOURCE_BUFFER_BYTES = (1 + SLOTS * WORDS_PER_SLOT) * 4;
export interface PhysicalResource { dev: string; ino: string }
/** 仅源模块内部由真实根/祖先认证派生；它不是文件描述符或源写资格。 */
export interface SourceNamespaceResource { readonly dev: string; readonly absolute: string }
export class PhysicalResourceBusy extends Error { constructor() { super('物理资源正被读取或独占，操作需要延期。'); } }
export interface PhysicalResourceGuard { release(): Promise<void> }
interface NamespaceGuardEntry { slots: readonly number[]; keys: readonly (readonly number[])[]; mode: 'read' | 'write'; released: boolean }
interface PhysicalWriteGuardEntry { slots: readonly number[]; keys: readonly (readonly number[])[]; released: boolean }
/** 同一 Core 与其 Owner Worker 共享原子表；不按逻辑 asset/root 标识加锁。 */
export class PhysicalResourceCoordinator {
  readonly buffer: SharedArrayBuffer;
  private readonly words: Int32Array;
  private readonly namespaceGuards = new WeakMap<object, NamespaceGuardEntry>();
  private readonly physicalWriteGuards = new WeakMap<object, PhysicalWriteGuardEntry>();
  constructor(buffer: SharedArrayBuffer = new SharedArrayBuffer(PHYSICAL_RESOURCE_BUFFER_BYTES)) {
    if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== PHYSICAL_RESOURCE_BUFFER_BYTES) throw new Error('物理资源协调器共享身份无效。');
    this.buffer = buffer; this.words = new Int32Array(buffer);
  }
  private transaction<T>(run: () => T): T {
    if (Atomics.compareExchange(this.words, 0, 0, 1) !== 0) throw new PhysicalResourceBusy();
    try { return run(); } finally { Atomics.store(this.words, 0, 0); }
  }
  private key(resource: PhysicalResource): number[] {
    // Node BigInt stat 可返回负值；保留原有符号，拒绝前导零等身份别名。
    if (typeof resource.dev !== 'string' || typeof resource.ino !== 'string' || !/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u.test(resource.dev) || !/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u.test(resource.ino)) throw new Error('物理资源身份无效。');
    const digest = createHash('sha256').update(`${BigInt(resource.dev)}:${BigInt(resource.ino)}`).digest();
    // 摘要碰撞只会保守地协调无关文件，不会绕过实际 dev/ino 的保护。
    return [digest.readInt32LE(0), digest.readInt32LE(4), digest.readInt32LE(8)];
  }
  private namespaceKey(resource: SourceNamespaceResource): number[] {
    if (typeof resource.dev !== 'string' || !/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u.test(resource.dev) || typeof resource.absolute !== 'string'
      || resource.absolute.length > 8192 || resource.absolute.includes('\0') || !path.isAbsolute(resource.absolute)
      || path.resolve(resource.absolute) !== resource.absolute || resource.absolute === path.parse(resource.absolute).root) throw new Error('源命名位身份无效。');
    const dev = Buffer.from(resource.dev, 'utf8'), named = Buffer.from(resource.absolute, 'utf8');
    const devLength = Buffer.allocUnsafe(4), namedLength = Buffer.allocUnsafe(4);
    devLength.writeUInt32BE(dev.length); namedLength.writeUInt32BE(named.length);
    const digest = createHash('sha256').update('MusicBridge.SourceNamespace.v1\0').update(devLength).update(dev).update(namedLength).update(named).digest();
    return [digest.readInt32LE(0), digest.readInt32LE(4), digest.readInt32LE(8)];
  }
  private acquire(resources: readonly PhysicalResource[], mode: 'read' | 'write'): PhysicalResourceGuard {
    if (!resources.length || resources.length > 128) throw new Error('物理资源集合须有界且非空。');
    const keys = [...new Map(resources.map(resource => { const key = this.key(resource); return [key.join(':'), key] as const; })).values()];
    const slots = this.acquireKeys(keys, mode);
    if (mode === 'write') {
      const guard: PhysicalResourceGuard = { release: () => this.releasePhysicalWriteGuards([guard]) };
      this.physicalWriteGuards.set(guard, { slots, keys, released: false });
      return Object.freeze(guard);
    }
    let released = false, releasing: Promise<void> | undefined;
    return { release: () => releasing ??= (async () => {
      if (released) return;
      // 释放只在调用者已 join I/O/关闭FD 后请求；短暂竞争异步让出，不阻塞UI。
      for (let attempt = 0; attempt < 1000; attempt++) {
        try {
          this.transaction(() => {
            // 先核原物理域与全部真实key；未知或其它域不能被旧read guard递减。
            for(const [index,offset] of slots.entries()){
              const value=Atomics.load(this.words,offset+3);
              if(value<1||value>MAX_READERS||!keys[index]!.every((word,at)=>Atomics.load(this.words,offset+at)===word))throw new Error('物理保护租约不一致。');
            }
            for(const offset of slots)Atomics.store(this.words,offset+3,Atomics.load(this.words,offset+3)-1);
          });released=true;return;
        }
        catch (error) { if (!(error instanceof PhysicalResourceBusy)) throw error; await immediate(); }
      }
      throw new Error('物理资源释放未确认，保护继续保留。');
    })() };
  }
  private acquireKeys(keys: readonly number[][], mode: 'read' | 'write', namespace = false): number[] {
    const slots = this.transaction(() => {
      const selected: number[] = [], reserved = new Set<number>();
      for (const key of keys) {
        let found = -1, empty = -1;
        for (let slot = 0; slot < SLOTS; slot++) {
          const offset = 1 + slot * WORDS_PER_SLOT, count = Atomics.load(this.words, offset + 3);
          if (count === 0 && empty < 0 && !reserved.has(offset)) empty = offset;
          if (count !== 0 && key.every((word, i) => Atomics.load(this.words, offset + i) === word)) { found = offset; break; }
        }
        const count = found >= 0 ? Atomics.load(this.words, found + 3) : 0;
        // 两域摘要即使碰撞也只拒绝，绝不共享或重解释另一域的真实租约。
        if (found >= 0 && (namespace ? count !== NAMESPACE_WRITE && !namespaceReadCount(count) : count !== -1 && !(count > 0 && count <= MAX_READERS))) throw new PhysicalResourceBusy();
        if (found >= 0 && (mode === 'write' || count < 0)) throw new PhysicalResourceBusy();
        const offset = found >= 0 ? found : empty;
        const readers = count === 0 ? 0 : namespace ? count - NAMESPACE_READ_BASE : count;
        if (offset < 0 || readers >= MAX_READERS) throw new PhysicalResourceBusy();
        selected.push(offset); reserved.add(offset);
      }
      for (let i = 0; i < selected.length; i++) {
        const offset = selected[i]!; keys[i]!.forEach((word, n) => Atomics.store(this.words, offset + n, word));
        const current = Atomics.load(this.words, offset + 3), readers = current === 0 ? 0 : namespace ? current - NAMESPACE_READ_BASE : current;
        Atomics.store(this.words, offset + 3, mode === 'write' ? namespace ? NAMESPACE_WRITE : -1 : namespace ? NAMESPACE_READ_BASE + readers + 1 : readers + 1);
      }
      return selected;
    });
    return slots;
  }
  acquireRead(resources: readonly PhysicalResource[]): PhysicalResourceGuard { return this.acquire(resources, 'read'); }
  acquireWrite(resources: readonly PhysicalResource[]): PhysicalResourceGuard { return this.acquire(resources, 'write'); }
  /** 只消费本作者真实物理 write guards；Source 全组 quiet 后一并收口，失败不能先放前组。 */
  async releasePhysicalWriteGuards(guards: readonly PhysicalResourceGuard[]): Promise<void> {
    if (!Array.isArray(guards) || guards.length > SLOTS) throw new Error('物理写保护收口集合超出原容量。');
    const entries = [...new Set(guards)].map(guard => {
      const entry = this.physicalWriteGuards.get(guard);
      if (!entry) throw new Error('物理写保护收口缺少同作者真实 write guard。');
      return entry;
    });
    for (let attempt = 0; attempt < 1000; attempt++) {
      try {
        this.transaction(() => {
          const selected = new Set<number>();
          for (const entry of entries) if (!entry.released) for (const [index, offset] of entry.slots.entries()) {
            if (selected.has(offset) || Atomics.load(this.words, offset + 3) !== -1
              || !entry.keys[index]!.every((word, at) => Atomics.load(this.words, offset + at) === word)) throw new Error('物理写保护全集尚未核实。');
            selected.add(offset);
          }
          if (selected.size > SLOTS) throw new Error('物理写保护收口超过原资源容量。');
          // 全集验证已经完成；SAB mutex 同时保护计数与本作者 released 状态。
          for (const offset of selected) Atomics.store(this.words, offset + 3, 0);
          for (const entry of entries) entry.released = true;
        });
        return;
      } catch (error) { if (!(error instanceof PhysicalResourceBusy)) throw error; await immediate(); }
    }
    throw new Error('物理写保护释放未确认，原全集保护继续保留。');
  }
  private acquireNamespace(resources: readonly SourceNamespaceResource[], mode: 'read' | 'write'): PhysicalResourceGuard {
    if (!Array.isArray(resources) || !resources.length || resources.length > 128) throw new Error('源命名位集合须在原单批容量内。');
    const keys = [...new Map(resources.map(resource => { const key = this.namespaceKey(resource); return [key.join(':'), key] as const; })).values()];
    const slots = this.acquireKeys(keys, mode, true);
    const guard: PhysicalResourceGuard = { release: () => this.releaseSourceNamespaceGuards([guard]) };
    this.namespaceGuards.set(guard, { slots, keys, mode, released: false });
    return Object.freeze(guard);
  }
  acquireSourceNamespaceRead(resources: readonly SourceNamespaceResource[]): PhysicalResourceGuard { return this.acquireNamespace(resources, 'read'); }
  acquireSourceNamespaceWrite(resources: readonly SourceNamespaceResource[]): PhysicalResourceGuard { return this.acquireNamespace(resources, 'write'); }
  /** 同一作者内真实 guards 的原子收口；先核全集再写，不能以负槽值收养已丢失的 token。 */
  async releaseSourceNamespaceGuards(guards: readonly PhysicalResourceGuard[]): Promise<void> {
    if (!Array.isArray(guards) || guards.length > SLOTS) throw new Error('源命名位收口集合超出原容量。');
    const entries = [...new Set(guards)].map(guard => {
      const entry = this.namespaceGuards.get(guard); if (!entry) throw new Error('源命名位收口缺少同作者真实保护。'); return entry;
    });
    for (let attempt = 0; attempt < 1000; attempt++) {
      try {
        this.transaction(() => {
          const changes = new Map<number, { mode: 'read' | 'write'; count: number }>();
          for (const entry of entries) if (!entry.released) for (const [index, offset] of entry.slots.entries()) {
            if (!entry.keys[index]!.every((word, at) => Atomics.load(this.words, offset + at) === word)) throw new Error('源命名位保护全集身份尚未核实。');
            const prior = changes.get(offset);
            if (prior && (prior.mode !== entry.mode || entry.mode === 'write')) throw new Error('源命名位保护全集不一致。');
            changes.set(offset, { mode: entry.mode, count: (prior?.count ?? 0) + 1 });
          }
          if (changes.size > SLOTS) throw new Error('源命名位收口超过原资源容量。');
          for (const [offset, change] of changes) {
            const value = Atomics.load(this.words, offset + 3);
            if (change.mode === 'write' ? value !== NAMESPACE_WRITE : !namespaceReadCount(value) || value - NAMESPACE_READ_BASE < change.count) throw new Error('源命名位保护释放尚未核实。');
          }
          for (const [offset, change] of changes) {
            const value = Atomics.load(this.words, offset + 3);
            const remaining = value - change.count;
            Atomics.store(this.words, offset + 3, change.mode === 'write' || remaining === NAMESPACE_READ_BASE ? 0 : remaining);
          }
          for (const entry of entries) entry.released = true;
        });
        return;
      } catch (error) { if (!(error instanceof PhysicalResourceBusy)) throw error; await immediate(); }
    }
    throw new Error('源命名位释放未确认，保护继续保留。');
  }
  /** 同一原子表的指定资源观察；只是事实快照，不签发源写资格。 */
  inspect(resources: readonly PhysicalResource[]): { readers: number; writers: number; resources: number } {
    if (!Array.isArray(resources) || resources.length > SLOTS) throw new Error('物理观察集合超过原协调器容量。');
    const keys = [...new Map(resources.map(resource => { const key = this.key(resource); return [key.join(':'), key] as const; })).values()];
    return this.transaction(() => {
      let readers = 0, writers = 0, matched = 0;
      for (const key of keys) for (let slot = 0; slot < SLOTS; slot++) {
        const offset = 1 + slot * WORDS_PER_SLOT, count = Atomics.load(this.words, offset + 3);
        if (count === 0 || !key.every((word, index) => Atomics.load(this.words, offset + index) === word)) continue;
        if (count !== -1 && !(count > 0 && count <= MAX_READERS)) throw new PhysicalResourceBusy();
        matched++; if (count > 0) readers += count; else writers++; break;
      }
      return { readers, writers, resources: matched };
    });
  }
  snapshot(): { readers: number; writers: number; resources: number } {
    return this.counts(false);
  }
  /** 新Source生命周期核两域完整占用；不把命名读者计入旧物理snapshot合同。 */
  combinedSnapshot(): { readers: number; writers: number; resources: number } {
    return this.counts(true);
  }
  private counts(combined:boolean): { readers: number; writers: number; resources: number } {
    return this.transaction(() => {
      let readers = 0, writers = 0, resources = 0;
      for(let slot=0;slot<SLOTS;slot++){
        const count=Atomics.load(this.words,1+slot*WORDS_PER_SLOT+3),named=count===NAMESPACE_WRITE||namespaceReadCount(count);
        if(count===0||named&&!combined)continue;
        resources++;if(count>0)readers+=namespaceReadCount(count)?count-NAMESPACE_READ_BASE:count;else writers++;
      }
      return {readers,writers,resources};
    });
  }
}
export let physicalResourceLocks = new PhysicalResourceCoordinator();
/** 仅可信启动组合调用，不能经Renderer或环境设置共享表。 */
export function installPhysicalResourceCoordinator(buffer: SharedArrayBuffer): void {
  const counts = physicalResourceLocks.combinedSnapshot(); if (counts.resources) throw new Error('活动物理保护期间不能替换协调器。');
  physicalResourceLocks = new PhysicalResourceCoordinator(buffer);
}
