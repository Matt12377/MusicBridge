import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, writeFileSync, readSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

type Common = typeof import('../../src/mobile-common.js');
type Catalog = typeof import('../../src/mobile-catalog.js');
type Resource = typeof import('../../src/mobile-resource.js');
type Content = typeof import('../../src/mobile-content.js');
type Wire = typeof import('../../src/mobile-wire.js');
export type FreshMobileContracts = {common:Common;catalog:Catalog;resource:Resource;content:Content;wire:Wire};
export type MobileWireContext = import('../../src/mobile-wire.js').MobileWireCodecContext;
export type MobileFixtureOperation = import('../../src/mobile-wire.js').MobileOperationId;
type TestFile = 'packages/contracts/test/mbm000/operation-contract.test.ts' | 'packages/contracts/test/mbm000/resource-envelope.test.ts' | 'packages/contracts/test/mbm000/audio-resource-state.test.ts' | 'packages/contracts/test/mbm000/content-revision.test.ts';
export const CHECKOUT = realpathSync(fileURLToPath(new URL('../../../../',import.meta.url)));
export const FIXTURE_ROOT = join(CHECKOUT,'packages/contracts/mobile/fixtures');
export const sha256 = (bytes:Uint8Array):string => createHash('sha256').update(bytes).digest('hex');
interface Input { path:string;bytes:number;sha256:string }
interface Artifact { file:string;relativePath:string;sourcePath:string;sourceSha256:string;bytes:number;sha256:string;mtimeMs:number;mtimeNs:string }
interface Binding {schema:string;root:string;head:string;predecessor:string;inputs:Input[];compiler:{startedMs:number;closedMs:number;exitCode:number;signal:null;closeObserved:boolean;timedOut:boolean;overflow:boolean;captureFailed:boolean;preparationFailed:boolean;groupTerminationFailed:boolean};artifacts:Artifact[];artifactIdentity:string}
function same(a:BigIntStats,b:BigIntStats):boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
/** 本轮完整 FD 读取；缺 binding 不回落 source、上一轮 dist 或 Mock。 */
export function readWholeFile(path:string):{bytes:Buffer;stat:BigIntStats} {
  const fd = openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = fstatSync(fd,{bigint:true}); assert(before.isFile()); assert(before.size >= 0n && before.size <= BigInt(Number.MAX_SAFE_INTEGER)); const buffer = Buffer.alloc(Number(before.size)); let at = 0;
    // 不改变 FD 的命名身份，完整读取至实际 size；额外一字节可见截尾/增长。
    while (at < buffer.length) { const n = readSync(fd,buffer,at,buffer.length-at,null); assert(n > 0); at += n; }
    const extra = Buffer.alloc(1); assert.equal(readSync(fd,extra,0,1,null),0); const after = fstatSync(fd,{bigint:true}); assert(same(before,after)); assert(same(after,lstatSync(path,{bigint:true}))); return {bytes:buffer,stat:after};
  } finally { closeSync(fd); }
}
function underRoot(path:string):string { const full = resolve(CHECKOUT,path); assert(full.startsWith(CHECKOUT + sep)); return full; }
const lexical = (a:string,b:string):number => a < b ? -1 : a > b ? 1 : 0;
const projectArtifacts = (rows:Artifact[]) => rows.map(({relativePath,bytes,sha256}) => ({relativePath,bytes,sha256})).sort((a,b) => lexical(a.relativePath,b.relativePath));
function checkInput(input:Input):void { assert(!isAbsolute(input.path)); const current = readWholeFile(underRoot(input.path)); assert.equal(current.bytes.length,input.bytes); assert.equal(sha256(current.bytes),input.sha256); }
function checkArtifact(row:Artifact,binding:Binding):void {
  assert(isAbsolute(row.file)); assert.equal(realpathSync(row.file),row.file); assert.equal(row.file,underRoot(row.relativePath));
  assert(binding.inputs.some(input => input.path === row.sourcePath && input.sha256 === row.sourceSha256));
  const actual = readWholeFile(row.file); assert.equal(actual.bytes.length,row.bytes); assert.equal(sha256(actual.bytes),row.sha256); assert.equal(actual.stat.mtimeNs.toString(),row.mtimeNs); assert(row.mtimeMs >= binding.compiler.startedMs && row.mtimeMs <= binding.compiler.closedMs);
}
export async function loadFreshMobileContracts(testFile:TestFile):Promise<FreshMobileContracts> {
  const path = process.env.MBM000_CONTRACT_BUILD_BINDING; assert(path && isAbsolute(path),'缺少本轮独立合同构建 binding。');
  const bound = readWholeFile(path), binding = JSON.parse(bound.bytes.toString('utf8')) as Binding;
  assert.equal(binding.schema,'musicbridge.mbm000.fresh-contracts-binding.v1'); assert.equal(binding.root,CHECKOUT); assert.match(binding.head,/^[0-9a-f]{40}$/u); assert.equal(binding.predecessor,'d3174bce575aa817b27ba05d39a40d3050b77be4');
  assert.equal(binding.compiler.exitCode,0); assert.equal(binding.compiler.signal,null); assert.equal(binding.compiler.closeObserved,true);
  for (const flag of ['timedOut','overflow','captureFailed','preparationFailed','groupTerminationFailed'] as const) assert.equal(binding.compiler[flag],false);
  assert(Number.isFinite(binding.compiler.startedMs) && binding.compiler.closedMs >= binding.compiler.startedMs);
  assert.equal(new Set(binding.inputs.map(input => input.path)).size,binding.inputs.length); binding.inputs.forEach(checkInput);
  assert.equal(new Set(binding.artifacts.map(row => row.relativePath)).size,binding.artifacts.length);
  assert.equal(sha256(Buffer.from(JSON.stringify(projectArtifacts(binding.artifacts)))),binding.artifactIdentity);
  const names = ['common','catalog','resource','content','wire'] as const, selected:Artifact[] = [];
  for (const name of names) for (const ext of ['.js','.js.map','.d.ts']) { const relative = `packages/contracts/dist/mobile-${name}${ext}`; const matches = binding.artifacts.filter(row => row.relativePath === relative); assert.equal(matches.length,1); assert.equal(matches[0]!.sourcePath,`packages/contracts/src/mobile-${name}.ts`); selected.push(matches[0]!); }
  selected.forEach(row => checkArtifact(row,binding));
  const modules:Record<string,unknown> = {};
  for (const name of names) { const row = selected.find(row => row.relativePath === `packages/contracts/dist/mobile-${name}.js`)!; modules[name] = await import(pathToFileURL(row.file).href); }
  selected.forEach(row => checkArtifact(row,binding)); binding.inputs.forEach(checkInput); const again = readWholeFile(path); assert.equal(sha256(again.bytes),sha256(bound.bytes));
  const consumption = process.env.MBM000_CONTRACT_CONSUMPTION_ROOT; assert(consumption && isAbsolute(consumption),'缺少本轮消费收据目录。'); assert.equal(realpathSync(consumption),consumption); assert(lstatSync(consumption).isDirectory()); assert.equal(lstatSync(consumption).mode & 0o777,0o700);
  const inputRows = binding.inputs.map(({path,bytes,sha256}) => ({path,bytes,sha256})).sort((a,b) => lexical(a.path,b.path));
  const receipt = {schema:'musicbridge.mbm000.contract-consumption.v1',testFile:testFile.slice('packages/contracts/'.length),head:binding.head,bindingSha256:sha256(bound.bytes),artifactIdentity:binding.artifactIdentity,inputIdentity:sha256(Buffer.from(JSON.stringify(inputRows))),artifacts:projectArtifacts(selected),loadedModules:selected.filter(row => row.relativePath.endsWith('.js')).map(row => row.relativePath).sort(lexical)};
  writeFileSync(join(consumption,`${basename(testFile)}.json`),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
  return modules as FreshMobileContracts;
}
export interface BodyDescriptor {fileName:string;bytes:number;sha256:string;encoding:'UTF8_JSON' | 'RAW_BINARY'}
export interface MobileFixtureCase {
  id:string;operationId:MobileFixtureOperation;method:string;pathTemplate:string;path:string;context:string;requestContext?:string;
  request:{headers:[string,string][];query:[string,string][];body:BodyDescriptor | null};
  response:{status:number;headers:[string,string][];finalUrl:string;body:BodyDescriptor};
  expected:{wireRequest:boolean;wireResponse:boolean;semanticResult:'ACCEPT' | 'REJECT' | 'SAFE_ERROR' | 'FAILED_RESOURCE' | 'BINARY_METADATA';note:string};
}
export interface MobileFixtureManifest {schema:string;documentVersion:string;baseWireContractVersion:string;uiCapabilitiesVersion:string;contexts:Record<string,MobileWireContext>;bodyFiles:BodyDescriptor[];cases:MobileFixtureCase[];operationCoverage:unknown;operationCount:number;bodyFileCount:number;caseCount:number;unknownCommandPolicy:unknown}
export function readFixtureBody(descriptor:BodyDescriptor | null):Uint8Array {
  if (descriptor === null) return new Uint8Array();
  assert(/^bodies\/[A-Za-z0-9_.-]+$/u.test(descriptor.fileName)); const current = readWholeFile(join(FIXTURE_ROOT,descriptor.fileName)); assert.equal(current.bytes.length,descriptor.bytes); assert.equal(sha256(current.bytes),descriptor.sha256); return new Uint8Array(current.bytes);
}
export function loadMobileFixtures():MobileFixtureManifest {
  const raw = readWholeFile(join(FIXTURE_ROOT,'manifest.json')); const manifest = JSON.parse(raw.bytes.toString('utf8')) as MobileFixtureManifest;
  assert.equal(manifest.schema,'musicbridge.mobile.full-body-fixture-manifest.v1'); assert.equal(new Set(manifest.cases.map(row => row.id)).size,manifest.cases.length);
  assert.equal(manifest.documentVersion,'1.6.0'); assert.equal(manifest.baseWireContractVersion,'0.1.0'); assert.equal(manifest.uiCapabilitiesVersion,'1.0.0');
  assert.equal(manifest.operationCount,40); assert.equal(manifest.bodyFileCount,manifest.bodyFiles.length); assert.equal(manifest.caseCount,manifest.cases.length); assert.equal(new Set(manifest.bodyFiles.map(body => body.fileName)).size,manifest.bodyFiles.length);
  manifest.bodyFiles.forEach(readFixtureBody);
  for (const row of manifest.cases) { assert(manifest.contexts[row.context]); if (row.requestContext !== undefined) assert(manifest.contexts[row.requestContext]); readFixtureBody(row.request.body); readFixtureBody(row.response.body); }
  return manifest;
}
export function requestContext(manifest:MobileFixtureManifest,row:MobileFixtureCase):MobileWireContext { return manifest.contexts[row.requestContext ?? row.context]!; }
export function responseContext(manifest:MobileFixtureManifest,row:MobileFixtureCase):MobileWireContext { return manifest.contexts[row.context]!; }
export function exerciseFixture(modules:FreshMobileContracts,manifest:MobileFixtureManifest,row:MobileFixtureCase):void {
  const request = modules.wire.decodeMobileRequest(row.operationId,{method:row.method,path:row.path,headers:row.request.headers,query:row.request.query,body:readFixtureBody(row.request.body)},requestContext(manifest,row));
  assert.equal(request.ok,row.expected.wireRequest,`${row.id}：请求实际 codec`);
  const response = modules.wire.decodeMobileResponse(row.operationId,{status:row.response.status,headers:row.response.headers,body:readFixtureBody(row.response.body),finalUrl:row.response.finalUrl},responseContext(manifest,row));
  assert.equal(response.ok,row.expected.wireResponse,`${row.id}：响应实际 codec`);
}
export const encode = (raw:unknown):Uint8Array => new TextEncoder().encode(JSON.stringify(raw));
export function plain<T>(raw:T):T { return JSON.parse(JSON.stringify(raw)) as T; }
export function fixtureJson<T>(descriptor:BodyDescriptor):T { assert.equal(descriptor.encoding,'UTF8_JSON'); return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readFixtureBody(descriptor))) as T; }
/** 改正文的负例同步真实 Content-Length，避免被另一个传输错误提前拒绝。 */
export function bodyHeaders(headers:readonly (readonly [string,string])[],body:Uint8Array):[string,string][] { return [...headers.filter(([name]) => name.toLowerCase() !== 'content-length').map(([name,value]) => [name,value] as [string,string]),['Content-Length',String(body.byteLength)]]; }
