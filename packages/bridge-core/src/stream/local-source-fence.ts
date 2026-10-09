/** Core与唯一Owner共享的短派发资格；没有路径、数据库或播放器依赖。 */
export const LOCAL_SOURCE_FENCE_BYTES = 16;
const VERSION = 1, VALID = 256, MAX_REFS = 4;
export class LocalFactsFenceBusy extends Error {
  private rolledBack = false;
  constructor(readonly fences: readonly LocalSourceFence[]) { super('相关本地派发尚未静止，数据库提交未完成。'); }
  confirmRollback(): void { this.rolledBack = true; }
  get canRetry(): boolean { return this.rolledBack; }
}
export class LocalSourceFence {
  private readonly words: Int32Array;
  constructor(readonly buffer: SharedArrayBuffer) {
    if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== LOCAL_SOURCE_FENCE_BYTES) throw new Error('本地来源私有票据尺寸无效。');
    this.words = new Int32Array(buffer);
    const state=Atomics.load(this.words,1);if(!((state>=0&&state<=MAX_REFS)||(state>=VALID&&state<=VALID+MAX_REFS)))throw new Error('本地来源私有票据状态无效。');
    if (Atomics.load(this.words, 0) !== VERSION || Atomics.load(this.words, 2) !== 0 || Atomics.load(this.words, 3) !== 0) throw new Error('本地来源私有票据版本无效。');
  }
  static create(): LocalSourceFence {
    const buffer = new SharedArrayBuffer(LOCAL_SOURCE_FENCE_BYTES), words = new Int32Array(buffer);
    Atomics.store(words, 0, VERSION); Atomics.store(words, 1, VALID); return new LocalSourceFence(buffer);
  }
  private state(): number { return Atomics.load(this.words, 1); }
  get references(): number { return this.state() & 255; }
  get current(): boolean { const state = this.state(); return state >= VALID && state <= VALID + MAX_REFS; }
  revoke(): void { Atomics.and(this.words, 1, ~VALID); }
  assertQuiet(): void { if (this.references !== 0) throw new LocalFactsFenceBusy([this]); }
  /** 持有读取资格直到真实 FD 静止；相关目录提交仍经过原唯一事实作者。 */
  retain(): () => void {
    for (;;) {
      const state = this.state();
      if (state < VALID || state >= VALID + MAX_REFS) throw new Error('本地来源读取资格已失效。');
      if (Atomics.compareExchange(this.words, 1, state, state + 1) !== state) continue;
      let released = false;
      return () => { if (released) return; released = true; Atomics.sub(this.words, 1, 1); Atomics.notify(this.words, 1); };
    }
  }
  dispatch<T>(send: () => T, assertCurrent: () => void = () => undefined): T {
    assertCurrent();
    for (;;) {
      const state = this.state();
      if (state < VALID || state >= VALID + MAX_REFS) throw new Error('本地来源派发资格已失效。');
      if (Atomics.compareExchange(this.words, 1, state, state + 1) !== state) continue;
      try { assertCurrent(); return send(); }
      finally { Atomics.sub(this.words, 1, 1); Atomics.notify(this.words, 1); }
    }
  }
}
/** 只重核确认ROLLBACK成功的同步数据库动作；不重试SDK或队列副作用。 */
export async function withLocalFactsMutation<T>(operation: () => T, recheck?: () => void | Promise<void>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try { await recheck?.(); return operation(); }
    catch (error) {
      if (!(error instanceof LocalFactsFenceBusy) || !error.canRetry || retry >= 2) throw error;
      const deadline = performance.now() + 250;
      while (error.fences.some(fence => fence.references !== 0)) {
        if (performance.now() >= deadline) throw error;
        await new Promise<void>(resolve => setTimeout(resolve, 5));
      }
    }
  }
}

/** COMMIT/ROLLBACK本身失败意味着连接结果未知；不能作为普通业务错误恢复票据。 */
export class LocalFactsCommitFatal extends Error { constructor() { super('工作库提交状态未知，本地派发资格已封口。'); } }
export function commitLocalFacts(db: {exec(sql: string): unknown}, fatal?: () => void): void {
  try { db.exec('COMMIT'); } catch { fatal?.(); throw new LocalFactsCommitFatal(); }
}
export function rollbackLocalFacts(db: {exec(sql: string): unknown}, error: unknown, fatal?: () => void): never {
  try { db.exec('ROLLBACK'); } catch { fatal?.(); throw new LocalFactsCommitFatal(); }
  if (error instanceof LocalFactsFenceBusy) error.confirmRollback(); throw error;
}
