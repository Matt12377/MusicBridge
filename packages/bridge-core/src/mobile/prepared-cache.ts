import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, unlink, rmdir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { MOBILE_DSD_PCM_PROCESSING_REASON, isMobileDsdSourceAudio, type MobileAudioInfo } from '@music-bridge/contracts';
import { openLocalPlaybackReadonlySource, type RootCapability } from '../recording/source-files.js';
import { closeMobileDsdSource, hashMobileDsdSource, isQualifiedMobileDsdConverter, mobileDsdSourceIdentity, verifyMobileDsdSource } from './dsd-converter.js';
import { MOBILE_DSD_RECIPE } from './mobile-ffmpeg-policy.js';
import { MOBILE_DSD_CACHE_LIMITS, MobileDsdError, type MobileDsdCacheLimits, type MobileDsdSourceAccess,
  type MobileDsdConverter, type MobileDsdOutput, type MobilePreparedCache, type MobileDsdCacheStatus } from './prepared-cache-types.js';
import type { MobilePlaybackPreparationWindow, MobilePlaybackPreparedSource, MobilePlaybackPreparingSource } from './source-types.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u, schema = 'musicbridge.mobile003.prepared-flac-cache.v1';
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code: MobileDsdError['code'] = 'RESOURCE_BUSY'): never => { throw new MobileDsdError(code); };
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const ds = Object.getOwnPropertyDescriptors(value); return Reflect.ownKeys(ds).length === keys.length
    && keys.every(k => ds[k]?.enumerable && Object.hasOwn(ds[k]!, 'value'));
}
interface Entry {
  id: string; key: string; identity: string; sourceSignature: string; sourceHash: string; backend: string;
  sourceAudio: MobileAudioInfo; durationMs: number; output: MobileDsdOutput;
  root: RootCapability; refs: Set<string>; lastUse: number;
}
interface Resource {
  id: string; source: MobileDsdSourceAccess; window: MobilePlaybackPreparationWindow; deadline: number;
  state: 'preparing' | 'ready' | 'failed' | 'released'; controller: AbortController; error: MobileDsdError | null;
  job: Job | null; entry: Entry | null; file: Awaited<ReturnType<typeof openLocalPlaybackReadonlySource>> | null;
  pending: Set<Promise<unknown>>; closing: Promise<void> | null; fromCache: boolean;
  expiresAt: number; timer: ReturnType<typeof setTimeout> | null;
}
interface Job {
  identity: string; signature: string; source: MobileDsdSourceAccess; deadline: number;
  resources: Set<Resource>; controller: AbortController; done: Promise<void>; started: boolean; accepting: boolean;
}

/** 缓存只有原 Dataset Owner 一个作者；不打开 SQLite，不在 Main 建 FD Pool。 */
export async function createMobilePreparedCache(options: {
  directory: string; datasetId: string; ownerEpoch: string; converter: MobileDsdConverter; assertCurrent(): void;
  limits?: Readonly<Partial<MobileDsdCacheLimits>>;
}): Promise<MobilePreparedCache> {
  if (!UUID.test(options.datasetId) || !UUID.test(options.ownerEpoch) || !isQualifiedMobileDsdConverter(options.converter)) return fail();
  const limits: MobileDsdCacheLimits = { ...MOBILE_DSD_CACHE_LIMITS };
  for (const [name, value] of Object.entries(options.limits ?? {})) {
    if (!Object.hasOwn(limits, name) || !Number.isSafeInteger(value) || value < 1 || value > limits[name as keyof MobileDsdCacheLimits]) return fail();
    limits[name as keyof MobileDsdCacheLimits] = value;
  }
  // 排空预留不作为可缩小的性能预算；测试只可收紧工作窗口。
  if (limits.quietReserveMs !== MOBILE_DSD_CACHE_LIMITS.quietReserveMs || limits.preparationMs <= limits.quietReserveMs) return fail();
  const directory = options.directory;
  if (!path.isAbsolute(directory) || path.basename(directory) !== 'mobile-dsd-cache') return fail();
  options.assertCurrent();
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const rootStat = await lstat(directory, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== BigInt(process.getuid?.() ?? -1)
    || (rootStat.mode & 0o777n) !== 0o700n || await realpath(directory) !== directory) return fail();
  const root: RootCapability = Object.freeze({ id: `mobile-cache-${options.datasetId}`, path: directory,
    dev: String(rootStat.dev), ino: String(rootStat.ino), authorized: true, label: '手机独立派生缓存' });
  const entries = new Map<string, Entry>(), resources = new Map<string, Resource>(), jobs = new Map<string, Job>();
  // 子进程关闭未证时持有原 FD 对象；GC 不能把未知发布/读取当作 quiet。
  const retainedFiles = new Set<FileHandle>();
  const queue: Job[] = []; let active: Job | null = null, closing = false, closeOperation: Promise<void> | null = null, occupied = 0, quarantined = 0, fatal = false;
  async function rootCurrent(): Promise<void> {
    options.assertCurrent(); const now = await lstat(directory, { bigint: true });
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== rootStat.dev || now.ino !== rootStat.ino || now.uid !== rootStat.uid
      || (now.mode & 0o777n) !== 0o700n || await realpath(directory) !== directory) return fail('SOURCE_CHANGED');
  }
  function current(): void { options.assertCurrent(); if (fatal) throw new MobileDsdError('RESOURCE_BUSY', false); if (closing) return fail('RESOURCE_RELEASED'); }
  function countWaiting(): number { return [...resources.values()].filter(r => r.state === 'preparing').length; }
  const prepared = (r: Resource): MobilePlaybackPreparedSource => {
    if (!r.entry || !r.file || r.state !== 'ready') return fail(r.error?.code ?? 'RESOURCE_BUSY');
    const e = r.entry; return Object.freeze<MobilePlaybackPreparedSource>({ handle: r.id, sourceAudio: { ...e.sourceAudio }, actualAudio: { ...e.output.actualAudio },
      processing: { mode:'dsd_to_pcm',reason:MOBILE_DSD_PCM_PROCESSING_REASON,fromPreparedCache:r.fromCache },
      contentType:'audio/flac',size:e.output.size,durationMs:e.durationMs,seekable:true });
  };
  const preparing = (r: Resource): MobilePlaybackPreparingSource => Object.freeze<MobilePlaybackPreparingSource>({ handle:r.id,preparing:true,
    sourceAudio:{...r.source.sourceAudio},processing:{mode:'dsd_to_pcm',reason:MOBILE_DSD_PCM_PROCESSING_REASON,fromPreparedCache:false},
    durationMs:r.source.durationMs,seekable:true });
  async function openEntry(r: Resource, e: Entry, fromCache: boolean): Promise<void> {
    if (r.controller.signal.aborted || r.state !== 'preparing' || Date.now() >= r.deadline) return fail('RESOURCE_RELEASED');
    await verifyMobileDsdSource(r.source); await rootCurrent();
    const file = await openLocalPlaybackReadonlySource(root, `${e.id}/audio.flac`);
    r.file = file;
    try {
      if (file.size !== e.output.size) return fail('SOURCE_CHANGED');
      const full = await hashFile(file.handle, file.size, () => { options.assertCurrent(); if (r.controller.signal.aborted || Date.now() >= r.deadline) return fail('RESOURCE_RELEASED'); });
      if (full !== e.output.sha256) return fail('SOURCE_CHANGED');
      await file.verify(); await verifyMobileDsdSource(r.source);
      if (r.controller.signal.aborted || r.state !== 'preparing') return fail('RESOURCE_RELEASED');
      r.entry = e; e.refs.add(r.id); r.fromCache = fromCache; r.state = 'ready'; e.lastUse = Date.now();
    } catch (error) {
      try { await file.close(); }
      catch {
        // 原 FD/guard 收尾未核实，保留 r.file 与容量；不能把 close 拒绝降成已 quiet 的来源变化。
        fatal = true; throw new MobileDsdError('RESOURCE_BUSY', false);
      }
      r.file = null; throw error;
    }
  }
  async function hashFile(file: FileHandle, size: number, check: () => void): Promise<string> {
    const digest = createHash('sha256'), chunk = Buffer.alloc(256 * 1024); let pos = 0;
    while (pos < size) { check(); const next = await file.read(chunk, 0, Math.min(size - pos, chunk.length), pos);
      if (!next.bytesRead) return fail('SOURCE_CHANGED'); digest.update(chunk.subarray(0, next.bytesRead)); pos += next.bytesRead; }
    check(); return digest.digest('hex');
  }
  async function readManifest(id: string): Promise<Entry | null> {
    const sub = path.join(directory, id), stat = await lstat(sub, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== rootStat.uid || (stat.mode & 0o777n) !== 0o700n || await realpath(sub) !== sub) return fail();
    const manifest = path.join(sub, 'manifest.json'); let handle: FileHandle;
    try { handle = await open(manifest, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    let raw: unknown;
    try { const a = await handle.stat({ bigint:true }); if (!a.isFile() || a.nlink !== 1n || a.size < 1n || a.size > 64n * 1024n || (a.mode & 0o777n) !== 0o600n) return fail();
      const text = Buffer.alloc(Number(a.size)); let offset = 0;
      while (offset < text.length) { const read = await handle.read(text, offset, text.length - offset, offset);
        if (!read.bytesRead) return fail('SOURCE_CHANGED'); offset += read.bytesRead; }
      const b = await handle.stat({bigint:true}), n = await lstat(manifest,{bigint:true});
      if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs
        || a.dev !== n.dev || a.ino !== n.ino || a.mtimeNs !== n.mtimeNs || a.ctimeNs !== n.ctimeNs) return fail(); raw = JSON.parse(text.toString('utf8'));
    } finally { await handle.close(); }
    if (!closed(raw, ['schema','datasetId','id','key','identity','sourceSignature','sourceHash','backend','recipe','sourceAudio','durationMs','output'])
      || raw.schema !== schema || raw.datasetId !== options.datasetId || raw.id !== id || ![raw.key,raw.identity,raw.sourceHash,raw.backend].every(v => typeof v === 'string' && SHA.test(v))
      || typeof raw.sourceSignature !== 'string' || raw.sourceSignature.length > 1024 || raw.recipe !== MOBILE_DSD_RECIPE || !isMobileDsdSourceAudio(raw.sourceAudio)
      || !Number.isSafeInteger(raw.durationMs) || Number(raw.durationMs) < 0 || !closed(raw.output,['size','sha256','actualAudio','samples'])
      || !Number.isSafeInteger(raw.output.size) || Number(raw.output.size) < 42 || Number(raw.output.size) > limits.entryBytes
      || typeof raw.output.sha256 !== 'string' || !SHA.test(raw.output.sha256) || !Number.isSafeInteger(raw.output.samples) || Number(raw.output.samples) < 1
      || !closed(raw.output.actualAudio,['codec','container','sampleRateHz','bitsPerSample','channels'])
      || raw.output.actualAudio.codec !== 'flac' || raw.output.actualAudio.container !== 'flac' || raw.output.actualAudio.sampleRateHz !== 48000
      || raw.output.actualAudio.bitsPerSample !== 24 || raw.output.actualAudio.channels !== raw.sourceAudio.channels) return fail();
    const expected = hash([options.datasetId,raw.identity,raw.sourceSignature,raw.sourceHash,MOBILE_DSD_RECIPE,raw.backend]); if (raw.key !== expected) return fail();
    const audio = await lstat(path.join(sub,'audio.flac'),{bigint:true});
    if (!audio.isFile() || audio.isSymbolicLink() || audio.nlink !== 1n || audio.size !== BigInt(Number(raw.output.size)) || (audio.mode & 0o777n) !== 0o600n) return fail();
    return { id,key:raw.key as string,identity:raw.identity as string,sourceSignature:raw.sourceSignature,sourceHash:raw.sourceHash as string,backend:raw.backend as string,
      sourceAudio:{...raw.sourceAudio},durationMs:Number(raw.durationMs),output:raw.output as unknown as MobileDsdOutput,root,refs:new Set(),lastUse:0 };
  }
  const inventory = await opendir(directory);
  try {
    for await (const dirent of inventory) {
      if (!UUID.test(dirent.name) || !dirent.isDirectory() || entries.size + quarantined >= limits.entries) return fail();
      const entry = await readManifest(dirent.name);
      if (!entry) { quarantined++; occupied += limits.entryBytes; continue; }
      if (entries.has(entry.key)) return fail(); entries.set(entry.key,entry); occupied += entry.output.size;
    }
  } finally { /* for-await 负责真实 closedir，异常也不二次 close。 */ }
  if (occupied > limits.totalBytes) return fail(); await rootCurrent();
  async function evictForReservation(): Promise<void> {
    current();
    const idle = [...entries.values()].filter(e => e.refs.size === 0).sort((a,b) => a.lastUse - b.lastUse);
    while (entries.size + quarantined >= limits.entries || occupied + limits.entryBytes > limits.totalBytes) {
      const e = idle.shift(); if (!e) return fail(); await rootCurrent();
      // 只删除完整本域 manifest 认证的两个文件，目录多出条目时 rmdir 拒绝而不递归删。
      const actual = await readManifest(e.id); if (!actual || actual.key !== e.key || actual.output.sha256 !== e.output.sha256) return fail('SOURCE_CHANGED');
      current();
      await unlink(path.join(directory,e.id,'audio.flac')); await unlink(path.join(directory,e.id,'manifest.json')); await rmdir(path.join(directory,e.id));
      entries.delete(e.key); occupied -= e.output.size;
    }
  }
  function jobCheck(job: Job): void {
    options.assertCurrent(); if (closing || job.controller.signal.aborted || job.resources.size === 0) return fail('RESOURCE_RELEASED');
    if (Date.now() >= job.deadline - limits.quietReserveMs) return fail('RESOURCE_BUSY');
  }
  async function execute(job: Job): Promise<void> {
    let writer: FileHandle | null = null, verification: FileHandle | null = null, workId: string | null = null, complete = false, quiet = true;
    try {
      const check = (): void => jobCheck(job), full = await hashMobileDsdSource(job.source, check), source = mobileDsdSourceIdentity(job.source);
      const key = hash([options.datasetId,source.identity,source.signature,full,MOBILE_DSD_RECIPE,options.converter.identity]);
      let e = entries.get(key), hit = !!e;
      if (e) {
        await rootCurrent(); verification = await open(path.join(directory,e.id,'audio.flac'),constants.O_RDONLY | constants.O_NOFOLLOW);
        const actual = await options.converter.verifyOutput(verification,job.source,check,limits.entryBytes);
        if (actual.sha256 !== e.output.sha256 || actual.size !== e.output.size || JSON.stringify(actual.actualAudio) !== JSON.stringify(e.output.actualAudio)) return fail('SOURCE_CHANGED');
        await verification.close(); verification = null;
      } else {
        await evictForReservation(); check(); await rootCurrent(); workId = randomUUID();
        await mkdir(path.join(directory,workId),{mode:0o700}); occupied += limits.entryBytes;
        const outputPath = path.join(directory,workId,'audio.flac');
        writer = await open(outputPath,constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,0o600);
        await options.converter.convert(job.source,writer,check,limits.entryBytes); await writer.sync(); await writer.close(); writer = null;
        verification = await open(outputPath,constants.O_RDONLY | constants.O_NOFOLLOW);
        const actual = await options.converter.verifyOutput(verification,job.source,check,limits.entryBytes);
        const first = await verification.stat({bigint:true}), named = await lstat(outputPath,{bigint:true});
        if (!named.isFile() || named.isSymbolicLink() || first.dev !== named.dev || first.ino !== named.ino || first.size !== named.size
          || first.mtimeNs !== named.mtimeNs || first.ctimeNs !== named.ctimeNs) return fail('SOURCE_CHANGED');
        await verification.close(); verification = null; check(); await hashMobileDsdSource(job.source,check); await rootCurrent();
        e = { id:workId,key,identity:source.identity,sourceSignature:source.signature,sourceHash:full,backend:options.converter.identity,
          sourceAudio:{...job.source.sourceAudio},durationMs:job.source.durationMs,output:actual,root,refs:new Set(),lastUse:Date.now() };
        const manifest = {schema,datasetId:options.datasetId,id:e.id,key:e.key,identity:e.identity,sourceSignature:e.sourceSignature,sourceHash:e.sourceHash,
          backend:e.backend,recipe:MOBILE_DSD_RECIPE,sourceAudio:e.sourceAudio,durationMs:e.durationMs,output:e.output};
        const fh = await open(path.join(directory,workId,'manifest.json'),constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,0o600);
        try { await fh.writeFile(JSON.stringify(manifest)); await fh.sync(); } finally { await fh.close(); }
        const dh = await open(path.join(directory,workId),constants.O_RDONLY | constants.O_NOFOLLOW); try { await dh.sync(); } finally { await dh.close(); }
        entries.set(key,e); occupied += actual.size - limits.entryBytes; complete = true;
      }
      // Set 的实时迭代会消费核验期间新加入的 waiter；收尾开始后新请求另排一份原 key 作业。
      for (const r of job.resources) {
        if (r.controller.signal.aborted || r.state !== 'preparing') continue;
        try { await verifyMobileDsdSource(r.source); if (mobileDsdSourceIdentity(r.source).signature !== source.signature) return fail('SOURCE_CHANGED');
          const opening = openEntry(r,e!,hit); r.pending.add(opening);
          try { await opening; } finally { r.pending.delete(opening); } hit = true; }
        catch (error) {
          r.error = error instanceof MobileDsdError ? error : new MobileDsdError('SOURCE_CHANGED'); r.state = 'failed';
          if (!r.error.quiet) throw r.error;
        }
      }
      job.accepting = false;
    } catch (error) {
      job.accepting = false;
      const safe = error instanceof MobileDsdError ? error : new MobileDsdError('SOURCE_CHANGED');
      for (const r of job.resources) if (r.state === 'preparing') { r.state = 'failed'; r.error = safe; }
      if (!safe.quiet) { quiet = false; fatal = true; throw safe; }
    } finally {
      if (!quiet) { if (verification) retainedFiles.add(verification); if (writer) retainedFiles.add(writer); }
      else {
      // 真 child close 已由 converter 证明；关闭所有写/核验FD后才回收本次 owned 半成品。
      await verification?.close(); await writer?.close();
      if (workId && !complete) {
        await rootCurrent(); await unlink(path.join(directory,workId,'audio.flac'));
        await unlink(path.join(directory,workId,'manifest.json')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        await rmdir(path.join(directory,workId)); occupied -= limits.entryBytes;
      }
      for (const r of job.resources) r.job = null;
      // 首个 waiter 取消不能先关 shared job 的源FD。此处只在真实作业 quiet 后关退休持有者。
      const owner = [...resources.values()].find(r => r.source === job.source);
      if (!owner || owner.state === 'released') await closeMobileDsdSource(job.source);
      }
    }
  }
  function pump(): void {
    if (active || closing || fatal) return; const next = queue.shift(); if (!next) return;
    active = next; next.started = true;
    const done = execute(next).then(() => { if (jobs.get(next.identity) === next) jobs.delete(next.identity); if (active === next) active = null; pump(); }, error => { fatal = true; throw error; });
    next.done = done; void done.catch(() => { /* quiet 未证则保留容量/资源；close/release 会观察同一个拒绝。 */ });
  }
  function waitingDeadline(window: MobilePlaybackPreparationWindow): number {
    const now = Date.now(), created = window.resourceCreatedAtMs;
    if (![created,window.resourceExpiresAtMs,window.sessionExpiresAtMs,window.remainingPreparationMs].every(Number.isSafeInteger)
      || created > now || window.remainingPreparationMs < 1 || window.remainingPreparationMs > limits.preparationMs
      || window.resourceExpiresAtMs <= created || window.sessionExpiresAtMs < window.resourceExpiresAtMs) return fail();
    return Math.min(created + limits.preparationMs, window.resourceExpiresAtMs, window.sessionExpiresAtMs, now + window.remainingPreparationMs);
  }
  async function release(resourceId: string): Promise<void> {
    const r = resources.get(resourceId); if (!r) return;
    r.controller.abort(); r.state = 'released'; if (r.timer) clearTimeout(r.timer); r.timer = null;
    return r.closing ??= (async () => {
      const job = r.job; job?.resources.delete(r);
      if (job && job.resources.size === 0) { job.controller.abort(); if (!job.started) { const index = queue.indexOf(job); if (index >= 0) queue.splice(index,1); jobs.delete(job.identity); await closeMobileDsdSource(job.source); } await job.done; }
      await Promise.allSettled([...r.pending]);
      if (r.file) { await r.file.close(); r.file = null; }
      r.entry?.refs.delete(r.id); r.entry = null;
      if (!job || job.source !== r.source || job.resources.size === 0 || active !== job && jobs.get(job.identity) !== job) await closeMobileDsdSource(r.source);
    })();
  }
  function renewLease(r: Resource): void {
    r.expiresAt = Math.min(Date.now() + 300_000, r.window.sessionExpiresAtMs);
    if (r.expiresAt <= Date.now()) return fail('RESOURCE_RELEASED');
    if (r.timer) clearTimeout(r.timer);
    r.timer = setTimeout(() => { void release(r.id).catch(() => { fatal = true; }); }, r.expiresAt - Date.now()); r.timer.unref();
  }
  const cache: MobilePreparedCache = Object.freeze({ get qualified(){ return !closing && !fatal; },
    async begin(request: {resourceId:string;source:MobileDsdSourceAccess;window:MobilePlaybackPreparationWindow}, signal:AbortSignal): Promise<MobileDsdCacheStatus> {
      current(); if (!UUID.test(request.resourceId) || signal.aborted) return fail('RESOURCE_RELEASED');
      const prior = resources.get(request.resourceId); if (prior) {
        const original = mobileDsdSourceIdentity(prior.source), next = mobileDsdSourceIdentity(request.source);
        if (original.identity !== next.identity || original.signature !== next.signature) return fail('SOURCE_CHANGED');
        if (prior.source !== request.source) await closeMobileDsdSource(request.source); return cache.status(prior.id);
      }
      if (resources.size >= 2048 || countWaiting() >= limits.waitingResources) return fail();
      const deadline = waitingDeadline(request.window); if (deadline - Date.now() <= limits.quietReserveMs) return fail();
      const identity = mobileDsdSourceIdentity(request.source), grouping = hash([identity.identity,identity.signature]);
      const r:Resource={id:request.resourceId,source:request.source,window:{...request.window},deadline,state:'preparing',controller:new AbortController(),
        error:null,job:null,entry:null,file:null,pending:new Set(),closing:null,fromCache:false,expiresAt:0,timer:null}; resources.set(r.id,r);renewLease(r);
      let job = jobs.get(grouping); if (job && !job.accepting) job = undefined;
      if (!job) { job={identity:grouping,signature:identity.signature,source:r.source,deadline,resources:new Set(),controller:new AbortController(),done:Promise.resolve(),started:false,accepting:true}; jobs.set(grouping,job); queue.push(job); }
      r.job=job; job.resources.add(r); pump(); return preparing(r);
    },
    async status(id:string):Promise<MobileDsdCacheStatus> { current(); const r=resources.get(id); if(!r || r.state==='released')return fail('RESOURCE_RELEASED');
      if(r.state==='failed')throw r.error!;
      if(r.state==='preparing'){if(Date.now()>=r.deadline-limits.quietReserveMs){await release(id);return fail();}await verifyMobileDsdSource(r.source);return preparing(r);}
      await cache.verify(id);return prepared(r); },
    async verify(id:string):Promise<void>{current();const r=resources.get(id);if(!r || r.state!=='ready' || !r.file)return fail('RESOURCE_RELEASED');
      if(Date.now()>=r.expiresAt){await release(id);return fail('RESOURCE_RELEASED');}
      await verifyMobileDsdSource(r.source);await rootCurrent();await r.file.verify();if(r.controller.signal.aborted)return fail('RESOURCE_RELEASED');},
    async renew(id:string):Promise<void>{await cache.verify(id);renewLease(resources.get(id)!);},
    async read(id:string,start:number,maximumBytes:number,signal:AbortSignal):Promise<Uint8Array>{
      current();const r=resources.get(id);if(!r || r.state!=='ready' || !r.file)return fail('RESOURCE_RELEASED');
      if(!Number.isSafeInteger(start)||start<0||start>r.file.size||!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>64*1024)return fail();
      const task=(async()=>{await cache.verify(id);if(signal.aborted||r.controller.signal.aborted)return fail('RESOURCE_RELEASED');
        const out=Buffer.alloc(Math.min(maximumBytes,r.file!.size-start));let position=0;
        while(position<out.length){const got=await r.file!.handle.read(out,position,out.length-position,start+position);if(!got.bytesRead)return fail('SOURCE_CHANGED');position+=got.bytesRead;}
        await cache.verify(id);if(signal.aborted||r.controller.signal.aborted)return fail('RESOURCE_RELEASED');return Uint8Array.from(out);})();
      r.pending.add(task);try{return await task;}finally{r.pending.delete(task);}
    }, release,
    close():Promise<void>{closing=true;return closeOperation??=(async()=>{for(const job of jobs.values())job.controller.abort();await Promise.all([...resources.keys()].map(release));await Promise.all([...jobs.values()].map(j=>j.done));})();},
    snapshot(){return Object.freeze({jobs:active?1:0,waitingResources:countWaiting(),entries:entries.size+quarantined,bytes:occupied,active:[...resources.values()].filter(r=>r.state==='ready').length,closing});},
  }); return cache;
}
