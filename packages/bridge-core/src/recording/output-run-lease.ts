import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { RenderSide } from '@music-bridge/contracts';
import { verifyPinnedDeviceOutputHelper, type PinnedDeviceOutputHelper } from './bundled-device-output-helper.js';

const BYTES = 288;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) && !/^0{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const sideCode = (side: RenderSide): number => side === 'A' ? 1 : side === 'B' ? 2 : side === 'Program' ? 3 : 0;
const idBytes = (value: string): Buffer => Buffer.from(value.replaceAll('-', ''), 'hex');
const fail = (): never => { throw new OutputRunLeaseError(); };

export class OutputRunLeaseError extends Error {
  readonly code = 'OUTPUT_RUN_LEASE_UNAVAILABLE';
  constructor() { super('正式输出运行租约未能证明精确身份或静止。'); }
}
export interface OutputRunLeaseBinding {
  databaseFile: string; datasetId: string; attemptId: string; side: RenderSide; runId: string;
  planContentSha256: string; audioSha256: string; pcmSha256: string; gateRecordSha256?: string;
  pin: PinnedDeviceOutputHelper;
}
export interface OutputRunLeaseHandle {
  readonly fd: number;
  readonly path: string;
  close(): Promise<void>;
}
interface FileIdentity { dev: bigint; ino: bigint; birthtimeNs: bigint }
const same = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const validFile = (info: { isFile(): boolean; nlink: bigint; mode: bigint }) =>
  info.isFile() && info.nlink === 1n && (info.mode & 0o022n) === 0n;
const named = async (file: string) => {
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || (info.mode & 0o022n) !== 0n
    || await realpath(file) !== file) return fail();
  return info;
};
function binding(value: OutputRunLeaseBinding): void {
  if (!path.isAbsolute(value.databaseFile) || value.databaseFile.includes('\0')
    || !uuid(value.datasetId) || !uuid(value.attemptId) || !uuid(value.runId) || !sideCode(value.side)
    || !hash(value.planContentSha256) || !hash(value.audioSha256) || !hash(value.pcmSha256)
    || value.gateRecordSha256 !== undefined && !hash(value.gateRecordSha256) || !hash(value.pin.sha256)) return fail();
}
function leasePath(value: OutputRunLeaseBinding): string {
  return `${value.databaseFile}.output-run-${value.runId}.lease`;
}
function putId(bytes: Buffer, offset: number, value: string): void { idBytes(value).copy(bytes, offset); }
function putHash(bytes: Buffer, offset: number, value: string): void { Buffer.from(value, 'hex').copy(bytes, offset); }
function matches(bytes: Buffer, value: OutputRunLeaseBinding, database: FileIdentity, lease: FileIdentity): boolean {
  if (bytes.length !== BYTES || bytes.toString('ascii', 0, 4) !== 'MBRL' || bytes.readUInt16LE(4) !== 1
    || (bytes[6] !== 1 && bytes[6] !== 2) || bytes[7] !== sideCode(value.side)
    || !bytes.subarray(272).every(byte => byte === 0)
    || bytes.readBigUInt64LE(40) !== database.dev || bytes.readBigUInt64LE(48) !== database.ino
    || bytes.readBigUInt64LE(56) !== database.birthtimeNs
    || bytes.readBigUInt64LE(64) !== lease.dev || bytes.readBigUInt64LE(72) !== lease.ino
    || !bytes.subarray(8, 24).equals(idBytes(value.runId))
    || bytes.subarray(24, 40).every(byte => byte === 0)
    || !bytes.subarray(80, 96).equals(idBytes(value.datasetId))
    || !bytes.subarray(96, 112).equals(idBytes(value.attemptId))
    || !bytes.subarray(112, 144).equals(Buffer.from(value.planContentSha256, 'hex'))
    || !bytes.subarray(144, 176).equals(Buffer.from(value.audioSha256, 'hex'))
    || !bytes.subarray(176, 208).equals(Buffer.from(value.pcmSha256, 'hex'))
    || !bytes.subarray(208, 240).equals(Buffer.from(value.pin.sha256, 'hex'))
    || value.gateRecordSha256 !== undefined && !bytes.subarray(240, 272).equals(Buffer.from(value.gateRecordSha256, 'hex'))
    || bytes.subarray(240, 272).every(byte => byte === 0)) return false;
  return true;
}
async function databaseIdentity(file: string): Promise<FileIdentity> {
  const info = await named(file);
  return { dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs };
}
async function readExactly(handle: FileHandle): Promise<Buffer> {
  const bytes = Buffer.alloc(BYTES);
  for (let offset = 0; offset < BYTES;) {
    const { bytesRead } = await handle.read(bytes, offset, BYTES - offset, offset);
    if (!bytesRead) return fail(); offset += bytesRead;
  }
  return bytes;
}

/** Attempt pending 已持久化之后、helper 可能触碰 HAL 之前创建；失败留下 sidecar 供人工核验，不删除。 */
export async function createOutputRunLease(value: OutputRunLeaseBinding): Promise<OutputRunLeaseHandle> {
  binding(value);
  if (!value.gateRecordSha256) return fail();
  await verifyPinnedDeviceOutputHelper(value.pin);
  const before = await databaseIdentity(value.databaseFile), file = leasePath(value);
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    const lease = await handle.stat({ bigint: true });
    if (!validFile(lease) || lease.size !== 0n) return fail();
    const bytes = Buffer.alloc(BYTES), generation = randomUUID();
    bytes.write('MBRL', 0, 'ascii'); bytes.writeUInt16LE(1, 4); bytes[6] = 1; bytes[7] = sideCode(value.side);
    putId(bytes, 8, value.runId); putId(bytes, 24, generation);
    bytes.writeBigUInt64LE(before.dev, 40); bytes.writeBigUInt64LE(before.ino, 48);
    bytes.writeBigUInt64LE(before.birthtimeNs, 56);
    bytes.writeBigUInt64LE(lease.dev, 64); bytes.writeBigUInt64LE(lease.ino, 72);
    putId(bytes, 80, value.datasetId); putId(bytes, 96, value.attemptId);
    putHash(bytes, 112, value.planContentSha256); putHash(bytes, 144, value.audioSha256);
    putHash(bytes, 176, value.pcmSha256); putHash(bytes, 208, value.pin.sha256);
    putHash(bytes, 240, value.gateRecordSha256);
    for (let offset = 0; offset < BYTES;) {
      const { bytesWritten } = await handle.write(bytes, offset, BYTES - offset, offset);
      if (!bytesWritten) return fail(); offset += bytesWritten;
    }
    await handle.sync();
    const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    const after = await databaseIdentity(value.databaseFile), self = await handle.stat({ bigint: true }), current = await named(file);
    if (!same(before, after) || !validFile(self) || self.size !== BigInt(BYTES)
      || self.dev !== current.dev || self.ino !== current.ino || self.birthtimeNs !== current.birthtimeNs
      || !matches(await readExactly(handle), value, before, { dev: self.dev, ino: self.ino, birthtimeNs: self.birthtimeNs })) return fail();
    let closed = false;
    return { fd: handle.fd, path: file, async close() { if (closed) return; closed = true; await handle.close(); } };
  } catch (error) {
    await handle.close();
    if (error instanceof OutputRunLeaseError) throw error;
    return fail();
  }
}

/** 冷启后由可信 datasetId/DB inode 与持久 Attempt/Plan/音频身份驱动；仅退出0表示墓碑已 fsync。 */
export async function revokeOutputRunLease(value: OutputRunLeaseBinding): Promise<boolean> {
  try {
    binding(value); await verifyPinnedDeviceOutputHelper(value.pin);
    const before = await databaseIdentity(value.databaseFile), file = leasePath(value);
    const handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const lease = await handle.stat({ bigint: true }), current = await named(file);
      if (!validFile(lease) || lease.size !== BigInt(BYTES) || lease.dev !== current.dev || lease.ino !== current.ino
        || lease.birthtimeNs !== current.birthtimeNs) return false;
      const bytes = await readExactly(handle);
      if (!matches(bytes, value, before, { dev: lease.dev, ino: lease.ino, birthtimeNs: lease.birthtimeNs })) return false;
      const result = spawnSync(value.pin.path, ['--lease-revoke'], { shell: false,
        env: { LANG: 'C', LC_ALL: 'C' }, input: bytes,
        stdio: ['pipe', 'pipe', 'pipe', 'ignore', handle.fd], timeout: 2_000, maxBuffer: 1024 });
      if (result.error || result.signal || result.status !== 0 || result.stdout?.length || result.stderr?.length) return false;
      const after = await databaseIdentity(value.databaseFile), namedLease = await named(file);
      if (!same(before, after) || namedLease.dev !== lease.dev || namedLease.ino !== lease.ino
        || namedLease.birthtimeNs !== lease.birthtimeNs) return false;
      const tombstone = await readExactly(handle);
      return tombstone[6] === 2 && matches(tombstone, value, before,
        { dev: lease.dev, ino: lease.ino, birthtimeNs: lease.birthtimeNs });
    } finally { await handle.close(); }
  } catch { return false; }
}
