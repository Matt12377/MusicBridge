import { workerData, type MessagePort } from 'node:worker_threads';
import { installMobileSqlQueryGate } from './mobile-sql-query-gate.js';

// 只在测试工厂中加入闸门，正式 SQL Worker 收到的仍是原闭集消息。
const gate = workerData.testSqlGate as SharedArrayBuffer, port = workerData.testSqlGatePort as MessagePort;
delete workerData.testSqlGate;
delete workerData.testSqlGatePort;
installMobileSqlQueryGate(gate, port, 6);
// 父版本不会创建隔离 Worker，故 RED 不会靠缺失模块失败；GREEN 必须进入真实新入口。
const privateEntry = '../../src/collection/local-album-browser/mobile-sql-worker-entry.js';
await import(privateEntry);
