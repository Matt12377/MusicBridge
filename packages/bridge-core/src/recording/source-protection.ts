import { randomUUID } from 'node:crypto';
import { organizerHash } from '../collection/local-organizer-journal.js';
import { physicalResourceLocks, PhysicalResourceBusy, type PhysicalResource } from '../stream/physical-resource-locks.js';
import { observeReadonlySourceProtection, observeSourceProtectionWithWriteClaims, observeSourceProtectionWithRetainedWriteClaims, SourceFileError, SourcePublicationUnverified, type PublicationSource, type ReadonlySourcePhysicalObservation } from './source-files.js';
import { assertPhysicalWriteClaims, assertRetainedPhysicalWriteClaims, type PhysicalWriteClaims } from '../stream/physical-resource-claims.js';
import type { SourceProtectionStore, SourceProtectionReference, SourceProtectionProjection } from './source-protection-store.js';
import type { SourceNamespaceHeldObservation } from '../stream/source-namespace-claims.js';
export type SourceProtectionNamespaceObservation=(source:PublicationSource)=>SourceNamespaceHeldObservation|undefined;

export interface SourceProtectionEvidence {
  version: 1; datasetId: string; fingerprint: string; storageFingerprint: string;
  state: 'PROTECTED' | 'UNKNOWN' | 'BUSY' | 'CLEAR'; complete: boolean; sourceWriterReady: false;
  resources: readonly PhysicalResource[]; references: readonly { kind: SourceProtectionReference['kind']; id: string }[];
  issues: readonly string[];
}
export class SourceProtectionRefused extends Error { constructor(readonly evidence: SourceProtectionEvidence) { super('源文件写入未就绪；持久引用、活动读取和未知证据不能绕过。'); } }
interface Options {
  store: SourceProtectionStore; datasetId: string; assertCurrent(): void; assertReady?(): void;
  /** 私有受控端口；不可从IPC或环境配置，超时只能收紧。 */
  observe?: typeof observeReadonlySourceProtection; timeoutMs?: number;
  /** 仅012作者内部选择；不从普通IPC或Renderer捕获，不改变旧snapshot指纹。 */
  sourceWrites?:true;
}
const identity = (resource: PhysicalResource): string => `${BigInt(resource.dev)}:${BigInt(resource.ino)}`;
/** 012/013 preview与执行重读同一函数；精确proof只描述事实，014始终不开放writer。 */
export function createSourceProtectionService(options: Options) {
  const observe = options.observe ?? observeReadonlySourceProtection, timeoutMs = options.timeoutMs ?? 15_000;
  const snapshot=():SourceProtectionProjection=>options.sourceWrites?options.store.sourceWritesSnapshot():options.store.snapshot();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error('来源保护观察时限只能收紧。');
  let closed = false, fatal: SourcePublicationUnverified | undefined;
  const observing = new Map<AbortController,Promise<ReadonlySourcePhysicalObservation>>();
  const assertCurrent = (): void => { if (closed || fatal) throw new Error('来源保护观察已封口。'); options.assertCurrent(); options.assertReady?.(); };
  function bounded(source: PublicationSource, deadline: number, held?:PhysicalWriteClaims,retained=false,namespace?:SourceProtectionNamespaceObservation): Promise<ReadonlySourcePhysicalObservation> {
    const controller = new AbortController();
    const operation = Promise.resolve().then(() => { assertCurrent(); return held?(retained?observeSourceProtectionWithRetainedWriteClaims:observeSourceProtectionWithWriteClaims)(source.root,source.relative,controller.signal,held,namespace?.(source)):observe(source.root,source.relative,controller.signal); })
      .then(value => { assertCurrent(); if (controller.signal.aborted) throw new Error('SOURCE_OBSERVATION_TIMEOUT'); return value; })
      .catch(error => { if (error instanceof SourcePublicationUnverified) fatal = error; throw error; })
      .finally(() => { observing.delete(controller); });
    observing.set(controller,operation); void operation.catch(() => {});
    return new Promise((resolve,reject) => {
      const remaining = deadline - Date.now();
      const timer = setTimeout(() => { controller.abort(); reject(new Error('SOURCE_OBSERVATION_TIMEOUT')); },Math.max(0,remaining));
      operation.then(value => { clearTimeout(timer); resolve(value); },error => { clearTimeout(timer); reject(error); });
    });
  }
  async function inspect(targets: readonly PublicationSource[], expectedFingerprint?: string, held?:PhysicalWriteClaims,retained=false,namespace?:SourceProtectionNamespaceObservation): Promise<SourceProtectionEvidence> {
      const assertHeld:typeof assertPhysicalWriteClaims=retained?assertRetainedPhysicalWriteClaims:assertPhysicalWriteClaims;
      const issues = new Set<string>(), observations: { key: string; observation: ReadonlySourcePhysicalObservation }[] = [];
      const resources: PhysicalResource[] = [], referenceKeys = new Set<string>();
      const hits: {kind: SourceProtectionReference['kind'];id:string}[] = [];
      let projection: SourceProtectionProjection | undefined, busy = false;
      const classify = (error: unknown): void => {
        if (error instanceof PhysicalResourceBusy) { busy = true; issues.add('PHYSICAL_RESOURCE_BUSY'); }
        else if (error instanceof SourcePublicationUnverified) issues.add('SOURCE_OBSERVATION_UNVERIFIED');
        else if (error instanceof SourceFileError) issues.add(error.code);
        else issues.add(error instanceof Error && error.message === 'SOURCE_OBSERVATION_TIMEOUT' ? error.message : 'PROTECTION_CONTEXT_UNAVAILABLE');
      };
      try {
        assertCurrent();
        if(held)assertHeld(held,[]);
        if (!Array.isArray(targets) || !targets.length || targets.length > 2048) throw new Error('SOURCE_PROTECTION_TARGET_BUDGET');
        projection = snapshot(); projection.issues.forEach(issue => issues.add(issue));
        const deadline = Date.now() + timeoutMs, observed = new Map<string,ReadonlySourcePhysicalObservation>();
        const key = (source: PublicationSource): string => organizerHash([source.root,source.relative]);
        for (const source of targets) {
          const value = await bounded(source,deadline,held,retained,namespace); observed.set(key(source),value); resources.push(value.physical);
          observations.push({key:key(source),observation:value});
        }
        const targetSet = new Set(resources.map(identity));
        const allLocations = new Map<string,PublicationSource>();
        for (const reference of projection.references) for (const location of reference.locations) {
          if (location.physical && targetSet.has(identity(location.physical))) {
            const refKey = `${reference.kind}:${reference.id}`;
            if (!referenceKeys.has(refKey)) { referenceKeys.add(refKey); hits.push({kind:reference.kind,id:reference.id}); }
          }
          const source = {root:location.root,relative:location.relative}; allLocations.set(key(source),source);
        }
        if (allLocations.size > 2048) issues.add('SOURCE_PROTECTION_RESOURCE_BUDGET');
        else {
          for (const [name,source] of allLocations) if (!observed.has(name)) {
            if (Date.now() >= deadline) { issues.add('SOURCE_OBSERVATION_TIMEOUT'); break; }
            try { const value = await bounded(source,deadline,held,retained,namespace); observed.set(name,value); observations.push({key:name,observation:value}); }
            catch (error) { classify(error); }
          }
          for (const reference of projection.references) if (reference.locations.some(location => {
            const value = observed.get(key({root:location.root,relative:location.relative})); return !!value && targetSet.has(identity(value.physical));
          })) {
            const refKey = `${reference.kind}:${reference.id}`;
            if (!referenceKeys.has(refKey)) { referenceKeys.add(refKey); hits.push({kind:reference.kind,id:reference.id}); }
          }
        }
        if(held){
          assertHeld(held,resources);
          // 每个目标恰是自己持有的一份写claim；其他活动不会被客户端ignoreBusy绕过。
          const activity=physicalResourceLocks.inspect(resources);
          const count=new Set(resources.map(identity)).size;
          if(activity.readers||activity.writers!==count||activity.resources!==count){busy=true;issues.add('PHYSICAL_RESOURCE_BUSY');}
        }else {const activity = physicalResourceLocks.inspect(resources); if (activity.readers || activity.writers) { busy = true; issues.add('PHYSICAL_RESOURCE_BUSY'); }}
        assertCurrent();
        // 原表在异步观察期间改变，不能用前一个projection签发当前proof。
        if (snapshot().storageFingerprint !== projection.storageFingerprint) issues.add('PROTECTION_CONTEXT_CHANGED');
      } catch (error) { classify(error); }
      const complete = !!projection?.complete && issues.size === 0;
      const state: SourceProtectionEvidence['state'] = hits.length ? 'PROTECTED' : busy ? 'BUSY' : complete ? 'CLEAR' : 'UNKNOWN';
      const material = {version:1,datasetId:options.datasetId,storageFingerprint:projection?.storageFingerprint ?? '0'.repeat(64),state,complete,sourceWriterReady:false,
        resources,hits,observations,issues:[...issues].sort()};
      let fingerprint: string;
      try { fingerprint = organizerHash(material); }
      catch { issues.add('SOURCE_PROTECTION_PROOF_BUDGET'); fingerprint = organizerHash([1,options.datasetId,material.storageFingerprint,'UNKNOWN',randomUUID()]); }
      if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) issues.add('PROTECTION_CONTEXT_CHANGED');
      return {version:1,datasetId:options.datasetId,fingerprint,storageFingerprint:material.storageFingerprint,state:issues.size && state === 'CLEAR' ? 'UNKNOWN' : state,
        complete:complete && issues.size === 0,sourceWriterReady:false,resources,references:hits,issues:[...issues].sort()};
  }
  return {
    inspect,
    inspectHeld(targets:readonly PublicationSource[],claims:PhysicalWriteClaims,expectedFingerprint?:string,namespace?:SourceProtectionNamespaceObservation):Promise<SourceProtectionEvidence>{return inspect(targets,expectedFingerprint,claims,false,namespace);},
    inspectRetained(targets:readonly PublicationSource[],claims:PhysicalWriteClaims,namespace?:SourceProtectionNamespaceObservation):Promise<SourceProtectionEvidence>{return inspect(targets,undefined,claims,true,namespace);},
    assertMutationAllowed(evidence: SourceProtectionEvidence): never { throw new SourceProtectionRefused(evidence); },
    async close(): Promise<void> { closed = true; for (const controller of observing.keys()) controller.abort(); await Promise.allSettled([...observing.values()]); if (fatal) throw fatal; },
  };
}
export type SourceProtectionService = ReturnType<typeof createSourceProtectionService>;
