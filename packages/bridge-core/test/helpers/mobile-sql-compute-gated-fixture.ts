import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { installMobileSqlQueryGate } from './mobile-sql-query-gate.js';

// 只在测试工厂中加入闸门，正式 SQL Worker 收到的仍是原闭集消息。
const gate = workerData.testSqlGate as SharedArrayBuffer, port = workerData.testSqlGatePort as MessagePort;
delete workerData.testSqlGate;
delete workerData.testSqlGatePort;
const fault = workerData.testStartupSqlFault;
delete workerData.testStartupSqlFault;
const auditPause = workerData.testAuditPause;
delete workerData.testAuditPause;
if (auditPause === 'catalog-ledger' || auditPause === 'scan-file-state') {
  const sql = auditPause === 'catalog-ledger'
    ? 'SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger ORDER BY rowid'
    : 'SELECT * FROM local_scan_file_state ORDER BY rowid';
  const original = DatabaseSync.prototype.prepare, state = new Int32Array(gate);
  const cancellation = new Int32Array(workerData.cancellation as SharedArrayBuffer);
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, text: string) {
    const statement = original.call(this, text);
    if (text !== sql) return statement;
    const iterate = statement.iterate.bind(statement);
    statement.iterate = (...args) => {
      const rows = Reflect.apply(iterate, statement, args) as ReturnType<typeof statement.iterate>;
      const next = rows.next.bind(rows), giveBack = rows.return?.bind(rows);
      rows.next = (...values) => {
        const row = next(...values);
        if (row.done) { port.postMessage({ type: 'sql.audit.exhausted' }); return row; }
        Atomics.add(state, 6, 1);
        if (Atomics.compareExchange(state, 0, 1, 0) === 1) {
          port.postMessage({ type: 'sql.audit.row' });
          const deadline = performance.now() + 5000; let cancelled = false;
          // 仅夹具阻塞真实首行的返回，观察生产 close 写入的原 SAB；不伪造取消或数据库结果。
          while (Atomics.load(state, 2) === 0) {
            if (!cancelled && Atomics.load(cancellation, 0) !== 0) {
              cancelled = true; port.postMessage({ type: 'sql.audit.cancel-seen' });
            }
            if (performance.now() >= deadline) { Atomics.store(state, 4, 1); throw new Error('全核迭代闸门未释放。'); }
            Atomics.wait(state, 2, 0, 10);
          }
        }
        return row;
      };
      if (giveBack) rows.return = (...values) => {
        const result = giveBack(...values); port.postMessage({ type: 'sql.audit.iterator-returned' }); return result;
      };
      return rows;
    };
    return statement;
  };
}
if (fault === 'audit') {
  const original = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = original.call(this, sql);
    if (sql === 'PRAGMA integrity_check') statement.get = () => ({ integrity_check: '受控核验失败' });
    return statement;
  };
}
if (fault === 'snapshot-without-change') {
  const send = parentPort!.postMessage.bind(parentPort!);
  parentPort!.postMessage = ((message: unknown, ...rest: unknown[]) => {
    const value = message as { type?: string; jobId?: number };
    return Reflect.apply(send, parentPort, [value.type === 'prepared'
      ? { type: 'failure', jobId: value.jobId, code: 'SNAPSHOT_CHANGED' } : message, ...rest]);
  }) as NonNullable<typeof parentPort>['postMessage'];
}
installMobileSqlQueryGate(gate, port, 6);
// 父版本不会创建隔离 Worker，故 RED 不会靠缺失模块失败；GREEN 必须进入真实新入口。
const privateEntry = '../../src/collection/local-album-browser/mobile-sql-worker-entry.js';
await import(privateEntry);
