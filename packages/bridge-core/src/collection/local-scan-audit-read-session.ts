import type { DatabaseSync, StatementSync } from 'node:sqlite';

/** 连接内同步核验的实际 SQL 水位，不是文件时间戳或跨连接内容证明。 */
const pointSql = 'SELECT total_changes() changes,(SELECT data_version FROM pragma_data_version) version,(SELECT schema_version FROM pragma_schema_version) schema,(SELECT user_version FROM pragma_user_version) userVersion,(SELECT foreign_keys FROM pragma_foreign_keys) foreignKeys';
const fields = ['changes', 'version', 'schema', 'temporary', 'userVersion', 'foreignKeys'] as const;
type Point = Record<typeof fields[number], number>;
export interface LocalScanAuditReadSession {
  readonly reusesOriginalTransaction: boolean;
  prepare(sql: string): StatementSync;
  assertCurrent(): void;
  close(): void;
}

/**
 * 只活在一次同步完整核验调用内。普通核验逐项实读原文；原冷启动事务才可复用
 * 已完整 guard 的有界 batch memo。每行仍读真实 state 与本连接 SQL 水位，任何
 * DML/主或临时 schema/事务/取消变化立即拒绝，不发布部分核验为可服务状态。
 * 不持有第二连接、Source 许可、跨调用证明或持久快照。
 */
export function createLocalScanAuditReadSession(options: {
  db: DatabaseSync;
  originalTransaction: boolean;
  assertReadActive?: () => void;
  fail(): never;
}): LocalScanAuditReadSession {
  const { db, assertReadActive, fail } = options;
  const statements = new Map<string, StatementSync>();
  let closed = false;
  function prepare(sql: string): StatementSync {
    if (closed) return fail();
    assertReadActive?.();
    const saved = statements.get(sql);
    if (saved) return saved;
    const statement = db.prepare(sql);
    // 水位语句也计入原来的32条总预算，不另设无界缓存。
    if (statements.size >= 32) statements.delete(statements.keys().next().value!);
    statements.set(sql, statement);
    return statement;
  }
  function readPoint(): Point {
    if (closed || !db.isTransaction) return fail();
    // Node22的schema_version表值pragma不接收schema参数；temp用原生pragma。
    // 所有取消回调先执行，再连续读取两条纯SQL，不能在两份水位之间运行调用方代码。
    const main = prepare(pointSql), temporary = prepare('PRAGMA temp.schema_version');
    const row = main.get(), temp = temporary.get();
    const point = row && temp ? { changes: Number(row.changes), version: Number(row.version), schema: Number(row.schema),
      temporary: Number(temp.schema_version), userVersion: Number(row.userVersion), foreignKeys: Number(row.foreignKeys) } : undefined;
    if (!db.isTransaction || !point || !row || !temp || fields.some(key => !Number.isSafeInteger(point[key]) || point[key] < 0)
      || ['changes', 'version', 'schema', 'userVersion', 'foreignKeys'].some(key => typeof row[key] !== 'number')
      || typeof temp.schema_version !== 'number' || point.foreignKeys !== 1) return fail();
    return point;
  }
  const initial = options.originalTransaction ? readPoint() : undefined;
  return Object.freeze({
    reusesOriginalTransaction: options.originalTransaction,
    prepare,
    assertCurrent() {
      if (closed) return fail();
      if (!initial) return;
      const current = readPoint();
      if (fields.some(key => current[key] !== initial[key])) return fail();
    },
    close() { closed = true; statements.clear(); },
  });
}
