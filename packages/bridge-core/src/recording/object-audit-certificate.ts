import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type ObjectAuditCertificateAction = 'begin' | 'progress' | 'terminal-event' | 'terminal-stop' | 'attempt-event' | 'attempt-command' | 'attempt-complete' | 'print-claim' | 'print-complete' | 'other';
export interface CertifiedObjectMetadata {
  scope: 'record-visual' | 'print-object';
  sha256: string;
  size: number;
  storage: string;
  mime?: string;
  width: number | null;
  height: number | null;
}

interface EnvironmentToken {
  dataVersion: number;
  totalChanges: number;
  state: string;
}
interface Certificate {
  token: EnvironmentToken;
  objects: Map<string, string>;
  receipts: Map<string, string>;
  snapshotVerified: boolean;
}
export interface ObjectAuditCertificateCandidate { readonly db: DatabaseSync; readonly certificate: Certificate }

const MAX_CERTIFICATE_BYTES = 16 * 1024 * 1024;
const MAX_CERTIFICATE_ENTRIES = 32_768;
const WRITTEN_TABLES = new Set([
  'recording_attempts', 'recording_attempt_events', 'recording_attempt_receipts',
  'recording_records', 'recording_record_current', 'recording_record_events', 'recording_record_permits', 'recording_record_visuals', 'recording_record_write_guard',
  'physical_copies', 'media_reservations', 'media_plans',
  'master_artwork_versions', 'master_artwork_current', 'recording_print_objects', 'recording_print_requests',
  'recording_print_jobs', 'recording_print_events', 'recording_print_artifacts', 'recording_print_receipts',
]);
const ALLOWED_WRITE_TRIGGERS = new Set([
  'recording_attempts_no_delete', 'recording_attempt_events_no_update', 'recording_attempt_events_no_delete',
  'recording_attempt_receipts_no_update', 'recording_attempt_receipts_no_delete',
  'recording_record_current_no_delete', 'recording_record_events_no_update', 'recording_record_events_no_delete',
  'recording_record_permits_no_update', 'recording_record_permits_no_delete',
  'recording_records_no_update', 'recording_records_no_delete', 'recording_record_visuals_no_update', 'recording_record_visuals_no_delete',
  'recording_attempt_copy_no_blank', 'recording_attempt_reservation_no_delete', 'recording_attempt_reservation_no_rebind', 'recording_attempt_active_media_no_update',
  'recording_record_permit_media_guard', 'recording_record_content_copy_guard', 'recording_record_permit_copy_guard',
  'master_artwork_versions_no_update', 'master_artwork_versions_no_delete', 'master_artwork_current_no_delete',
  'recording_print_objects_no_update', 'recording_print_objects_no_delete',
  'recording_print_requests_no_update', 'recording_print_requests_no_delete', 'recording_print_jobs_no_delete',
  'recording_print_events_no_update', 'recording_print_events_no_delete',
  'recording_print_artifacts_no_update', 'recording_print_artifacts_no_delete',
  'recording_print_receipts_no_update', 'recording_print_receipts_no_delete',
]);

function scalar(db: DatabaseSync, sql: string, key: string): number {
  return Number(db.prepare(sql).get()?.[key]);
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function environment(db: DatabaseSync): EnvironmentToken | null {
  try {
    if (!db.isTransaction) return null;
    const temp = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_temp_schema ORDER BY type,name").all();
    if (temp.length !== 0) return null;
    const databases = db.prepare('PRAGMA database_list').all();
    const main=databases[0],temporary=databases[1];
    if ((databases.length !== 1 && databases.length !== 2) || main?.seq !== 0 || main?.name !== 'main' || typeof main?.file !== 'string' || main.file.length === 0
      || databases.length === 2 && (temporary?.seq !== 1 || temporary?.name !== 'temp' || temporary?.file !== '')) return null;
    const pragmas = {
      foreignKeys: scalar(db, 'PRAGMA foreign_keys', 'foreign_keys'),
      recursiveTriggers: scalar(db, 'PRAGMA recursive_triggers', 'recursive_triggers'),
      trustedSchema: scalar(db, 'PRAGMA trusted_schema', 'trusted_schema'),
      ignoreChecks: scalar(db, 'PRAGMA ignore_check_constraints', 'ignore_check_constraints'),
      writableSchema: scalar(db, 'PRAGMA writable_schema', 'writable_schema'),
      queryOnly: scalar(db, 'PRAGMA query_only', 'query_only'),
      deferredForeignKeys: scalar(db, 'PRAGMA defer_foreign_keys', 'defer_foreign_keys'),
      userVersion: scalar(db, 'PRAGMA user_version', 'user_version'),
      schemaVersion: scalar(db, 'PRAGMA schema_version', 'schema_version'),
      synchronous: scalar(db, 'PRAGMA synchronous', 'synchronous'),
    };
    if (pragmas.foreignKeys !== 1 || pragmas.recursiveTriggers !== 0 || ![0,1].includes(pragmas.trustedSchema) || pragmas.ignoreChecks !== 0 || pragmas.writableSchema !== 0 || pragmas.queryOnly !== 0 || pragmas.deferredForeignKeys !== 0 || ![0,1,2,3].includes(pragmas.synchronous)) return null;
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    for (const item of schema) {
      if (item.type === 'trigger' && WRITTEN_TABLES.has(String(item.tbl_name)) && !ALLOWED_WRITE_TRIGGERS.has(String(item.name))) return null;
    }
    return {
      dataVersion: scalar(db, 'PRAGMA data_version', 'data_version'),
      totalChanges: scalar(db, 'SELECT total_changes() AS total_changes', 'total_changes'),
      state: digest({ databases, pragmas, schema }),
    };
  } catch {
    return null;
  }
}
function objectKey(value: CertifiedObjectMetadata): string { return `${value.scope}:${value.sha256}`; }
function objectValue(value: CertifiedObjectMetadata): string {
  return digest({ size: value.size, storage: value.storage, mime: value.mime ?? null, width: value.width, height: value.height });
}

export class ObjectAuditCertificateSession {
  readonly reusable: boolean;
  readonly requiresObjectAudit: boolean;
  readonly requiresPrintAudit: boolean;
  readonly #entry: EnvironmentToken | null;
  readonly #prior: Certificate | null;
  readonly #objects = new Map<string, string>();
  readonly #receipts = new Map<string, string>();
  readonly #seenObjects = new Set<string>();
  readonly #seenReceipts = new Set<string>();
  #retainedBytes = 0;
  #retainedEntries = 0;
  #overflow = false;
  #reuseMiss = false;
  #expectedAttemptMutations: number | undefined;
  #expectedPrintMutations: number | undefined;
  #expectedCompletionMutations: number | undefined;
  #expectedBeginMutations: 0 | 5 | 6 | undefined;
  #invalidMutationExpectation = false;
  #snapshotVerified = false;
  #snapshotReused = false;
  constructor(readonly db: DatabaseSync, readonly action: ObjectAuditCertificateAction, prior: Certificate | null) {
    this.#entry = environment(db);
    this.#prior = prior;
    this.reusable = ['begin', 'progress', 'terminal-event', 'terminal-stop', 'attempt-event', 'attempt-command', 'attempt-complete', 'print-claim', 'print-complete'].includes(action) && this.#entry !== null && prior !== null
      && prior.token.dataVersion === this.#entry.dataVersion && prior.token.totalChanges === this.#entry.totalChanges && prior.token.state === this.#entry.state;
    if (this.reusable && prior) {
      this.#retainedEntries = prior.objects.size + prior.receipts.size;
      for (const [key,value] of [...prior.objects,...prior.receipts]) this.#retainedBytes += (key.length + value.length) * 2 + 256;
    }
    this.requiresObjectAudit = prior !== null && !this.reusable;
    this.requiresPrintAudit = prior !== null && !this.reusable && (prior.receipts.size > 0 || [...prior.objects.keys()].some(key=>key.startsWith('print-object:')));
  }
  matchesObject(value: CertifiedObjectMetadata): boolean {
    if (!this.reusable || !this.#prior) return false;
    const key = objectKey(value);
    if (!this.#prior.objects.has(key)) return false;
    const matched = this.#prior.objects.get(key) === objectValue(value);
    if (matched) this.#seenObjects.add(key); else this.#reuseMiss = true;
    return matched;
  }
  observeObject(value: CertifiedObjectMetadata): void {
    if (!['begin', 'progress', 'terminal-event', 'terminal-stop', 'attempt-event', 'attempt-command', 'attempt-complete', 'print-claim', 'print-complete'].includes(this.action) || this.#entry === null || this.#overflow) return;
    if (this.reusable && this.#prior?.objects.has(objectKey(value))) {
      if (this.#prior.objects.get(objectKey(value)) !== objectValue(value)) this.#reuseMiss = true;
      return;
    }
    this.#retain(this.#objects, objectKey(value), objectValue(value));
  }
  matchesReceipt(key: string, value: string): boolean {
    if (!this.reusable || !this.#prior) return false;
    if (!this.#prior.receipts.has(key)) return false;
    const matched = this.#prior.receipts.get(key) === value;
    if (matched) this.#seenReceipts.add(key); else this.#reuseMiss = true;
    return matched;
  }
  observeReceipt(key: string, value: string): void {
    if (!['begin', 'progress', 'terminal-event', 'terminal-stop', 'attempt-event', 'attempt-command', 'attempt-complete', 'print-claim', 'print-complete'].includes(this.action) || this.#entry === null || this.#overflow) return;
    if (this.reusable && this.#prior?.receipts.has(key)) {
      if (this.#prior.receipts.get(key) !== value) this.#reuseMiss = true;
      return;
    }
    this.#retain(this.#receipts, key, value);
  }
  /** 复用只覆盖同一DB中已完整核验且环境／写入戳均未变化的Record／Print结构快照。 */
  reuseSnapshot(): boolean {
    const reusable = this.reusable && this.#prior?.snapshotVerified === true;
    if (reusable) this.#snapshotReused = true;
    return reusable;
  }
  observeSnapshotVerified(): void { this.#snapshotVerified = true; }
  /** Attempt-only事务必须声明实际新增event/receipt数；候选只接受与SQLite total_changes完全相等的delta。 */
  expectAttemptMutations(eventEntries: 0 | 1 | 2 | 3 | 4, receiptEntries: 0 | 1): void {
    const singleEvent = this.action === 'progress' || this.action === 'terminal-event';
    const valid = (singleEvent && eventEntries <= 1 && receiptEntries === 0)
      || (this.action === 'attempt-event' && eventEntries <= 1 && receiptEntries === 0)
      || (this.action === 'attempt-command' && eventEntries <= 1 && receiptEntries <= 1)
      || (this.action === 'terminal-stop' && receiptEntries <= 1);
    if (!valid || this.#expectedAttemptMutations !== undefined) { this.#invalidMutationExpectation = true; return; }
    this.#expectedAttemptMutations = eventEntries * 2 + receiptEntries;
  }
  /** Begin固定写入Attempt三行及Record两／三行；分支必须由生产写路径精确声明。 */
  expectBeginMutations(entries: 0 | 5 | 6): void {
    if (this.action !== 'begin' || this.#expectedBeginMutations !== undefined || ![0, 5, 6].includes(entries)) {
      this.#invalidMutationExpectation = true; return;
    }
    this.#expectedBeginMutations = entries;
  }
  /** Print热事务只接受公开写路径的精确SQLite行变化；对象去重使complete为4/5/6行。 */
  expectPrintMutations(entries: 0 | 2 | 4 | 5 | 6): void {
    const valid = this.action === 'print-claim' ? entries === 0 || entries === 2
      : this.action === 'print-complete' && [0, 4, 5, 6].includes(entries);
    if (!valid || this.#expectedPrintMutations !== undefined) { this.#invalidMutationExpectation = true; return; }
    this.#expectedPrintMutations = entries;
  }
  /** Completed会原子写Attempt、Record、可选Print及新visual；调用方按实际公开分支声明总行变化。 */
  expectCompletionMutations(entries: number): void {
    const valid=entries===0 || Number.isSafeInteger(entries) && entries>=11 && entries<=96;
    if(this.action!=='attempt-complete'||!valid||this.#expectedCompletionMutations!==undefined){this.#invalidMutationExpectation=true;return;}
    this.#expectedCompletionMutations=entries;
  }
  candidate(): ObjectAuditCertificateCandidate | null {
    const next = environment(this.db);
    if (!next || !this.#entry || next.dataVersion !== this.#entry.dataVersion || next.state !== this.#entry.state) return null;
    const delta = next.totalChanges - this.#entry.totalChanges;
    if (this.action === 'begin') {
      if (this.#overflow || this.#invalidMutationExpectation || this.#expectedBeginMutations === undefined || delta !== this.#expectedBeginMutations) return null;
      if(!this.reusable)return { db: this.db, certificate: { token: next, objects: this.#objects, receipts: this.#receipts, snapshotVerified: this.#snapshotVerified } };
      const completeReuse=this.#snapshotReused&&this.#prior?.snapshotVerified===true;
      const rawReuse=this.#prior&&!this.#reuseMiss&&this.#seenObjects.size===this.#prior.objects.size&&this.#seenReceipts.size===this.#prior.receipts.size;
      if(!this.#prior||!completeReuse&&!rawReuse)return null;
      const objects=new Map(this.#prior.objects),receipts=new Map(this.#prior.receipts);
      for(const [key,value] of this.#objects)objects.set(key,value);for(const [key,value] of this.#receipts)receipts.set(key,value);
      return {db:this.db,certificate:{token:next,objects,receipts,snapshotVerified:completeReuse||this.#snapshotVerified}};
    }
    const expectedMutations = this.action === 'print-claim' || this.action === 'print-complete' ? this.#expectedPrintMutations
      : this.action==='attempt-complete'?this.#expectedCompletionMutations:this.#expectedAttemptMutations;
    const exactDelta = !this.#invalidMutationExpectation && expectedMutations !== undefined && delta === expectedMutations;
    // 冷store没有Begin证书时，首次白名单事务已完整核验结构／对象；精确写入后可从该事实建立锚点。
    if (this.action !== 'other' && !this.reusable && this.#entry !== null && !this.#overflow && exactDelta && this.#snapshotVerified) {
      return { db: this.db, certificate: { token: next, objects: this.#objects, receipts: this.#receipts, snapshotVerified: true } };
    }
    const completeReuse = this.#snapshotReused && this.#prior?.snapshotVerified === true;
    const rawReuse = this.#prior && !this.#reuseMiss && this.#seenObjects.size === this.#prior.objects.size && this.#seenReceipts.size === this.#prior.receipts.size;
    if (this.action !== 'other' && this.reusable && this.#prior && !this.#overflow && !this.#reuseMiss && exactDelta && (completeReuse || rawReuse)) {
      const objects=new Map(this.#prior.objects),receipts=new Map(this.#prior.receipts);
      for(const [key,value] of this.#objects)objects.set(key,value);for(const [key,value] of this.#receipts)receipts.set(key,value);
      return { db: this.db, certificate: { token: next, objects, receipts,
        snapshotVerified: completeReuse || this.#snapshotVerified } };
    }
    return null;
  }
  #retain(target: Map<string, string>, key: string, value: string): void {
    if (target.has(key)) {
      if (target.get(key) !== value) this.#overflow = true;
      return;
    }
    const cost = (key.length + value.length) * 2 + 256;
    if (this.#retainedEntries + this.#objects.size + this.#receipts.size >= MAX_CERTIFICATE_ENTRIES || this.#retainedBytes + cost > MAX_CERTIFICATE_BYTES) {
      this.#overflow = true; this.#objects.clear(); this.#receipts.clear(); return;
    }
    target.set(key, value); this.#retainedBytes += cost;
  }
}

export function createObjectAuditCertificateManager(disabled = false) {
  const certificates = new WeakMap<DatabaseSync, Certificate>();
  return {
    begin(db: DatabaseSync, action: ObjectAuditCertificateAction): ObjectAuditCertificateSession {
      if (disabled || action === 'other') certificates.delete(db);
      return new ObjectAuditCertificateSession(db, disabled ? 'other' : action, disabled ? null : certificates.get(db) ?? null);
    },
    publish(db: DatabaseSync, candidate: ObjectAuditCertificateCandidate | null): void {
      if (disabled || !candidate) certificates.delete(db); else certificates.set(candidate.db, candidate.certificate);
    },
    clear(db: DatabaseSync): void { certificates.delete(db); },
  };
}
export type ObjectAuditCertificateManager = ReturnType<typeof createObjectAuditCertificateManager>;

export function receiptCertificateValue(row: Record<string, unknown>): string {
  return digest({ id: row.id, kind: row.kind, fingerprint: row.fingerprint, request: row.request, result: row.result });
}
