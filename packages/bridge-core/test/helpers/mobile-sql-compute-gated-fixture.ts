import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { installMobileSqlQueryGate } from './mobile-sql-query-gate.js';

// 只在测试工厂中加入闸门，正式 SQL Worker 收到的仍是原闭集消息。
const gate = workerData.testSqlGate as SharedArrayBuffer, port = workerData.testSqlGatePort as MessagePort;
delete workerData.testSqlGate;
delete workerData.testSqlGatePort;
const fault = workerData.testStartupSqlFault;
delete workerData.testStartupSqlFault;
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
