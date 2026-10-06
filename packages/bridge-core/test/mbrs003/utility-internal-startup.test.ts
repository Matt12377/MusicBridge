import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import * as dto from '@music-bridge/contracts';
import {audioFixture,loadFreshMetadataReader} from '../helpers/mbrs003-audio-fixtures.js';
import type {UtilityPort,DatasetOwnerFactory} from '../../src/utility-main.js';
import type {DatasetOwnerEndpoint,DatasetOwnerIdentity} from '../../src/collection/dataset-owner-protocol.js';

interface FileIdentity {file:string;bytes:number;sha256:string}
interface StartupBinding {
  schema:'mbrs003.utility-startup.fresh-build.v1';compilerExit:0;
  compilerStartedAtMs:number;compilerFinishedAtMs:number;
  sourceInputs:FileIdentity[];outputs:FileIdentity[];
}
const coreRoot=fileURLToPath(new URL('../../',import.meta.url));
const compiledSources=[
  'src/utility-main.ts','src/rust-core/optional-readonly-manager.ts',
  'src/collection/dataset-owner-client.ts','src/collection/dataset-domain.ts',
  'src/collection/dataset-owner-worker.ts',
] as const;
const fixtureSource='test/helpers/dataset-owner-fixture.ts';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const same=(a:unknown,b:unknown,message:string)=>assert.equal(isDeepStrictEqual(a,b),true,message);
// root从独立precompile原件取pin，全core编译成功并核全部输入不变后签发本声明。
// 测试只消费声明；缺少声明或陈旧编译属于准备失败，不能算目标RED。
async function freshRuntime(){
  await loadFreshMetadataReader();
  const declaration=process.env.MBRS003_STARTUP_BUILD_BINDING;
  assert.equal(typeof declaration==='string'&&path.isAbsolute(declaration),true,'PREPARATION_FAILED: 缺少启动链fresh编译声明');
  const binding=JSON.parse(await readFile(declaration!,'utf8')) as StartupBinding;
  assert.equal(binding.schema,'mbrs003.utility-startup.fresh-build.v1');
  assert.equal(binding.compilerExit,0);
  assert.equal(Number.isFinite(binding.compilerStartedAtMs)&&binding.compilerStartedAtMs>0&&
    Number.isFinite(binding.compilerFinishedAtMs)&&binding.compilerFinishedAtMs>=binding.compilerStartedAtMs,true);
  assert.equal(binding.sourceInputs.length,6);assert.equal(binding.outputs.length,10);
  assert.equal(new Set(binding.sourceInputs.map(x=>x.file)).size,6);
  assert.equal(new Set(binding.outputs.map(x=>x.file)).size,10);
  const sources=new Map(binding.sourceInputs.map(x=>[x.file,x]));
  const outputs=new Map(binding.outputs.map(x=>[x.file,x]));
  async function check(identity:FileIdentity|undefined,file:string,fresh:boolean){
    assert.ok(identity,'PREPARATION_FAILED: 缺少指定输入或产物');assert.equal(identity.file,file);
    assert.equal(Number.isSafeInteger(identity.bytes)&&identity.bytes>0&&/^[a-f0-9]{64}$/u.test(identity.sha256),true);
    const target=path.join(coreRoot,file),info=await lstat(target);
    assert.equal(info.isFile()&&!info.isSymbolicLink(),true);assert.equal(await realpath(target),target);
    const bytes=await readFile(target);assert.equal(bytes.length,identity.bytes);assert.equal(hash(bytes),identity.sha256);
    if(fresh)assert.equal(info.mtimeMs>=binding.compilerStartedAtMs-1000&&info.mtimeMs<=binding.compilerFinishedAtMs+1000,true,'PREPARATION_FAILED: 产物不属本次编译');
  }
  await check(sources.get(fixtureSource),fixtureSource,false);
  for(const source of compiledSources){
    await check(sources.get(source),source,false);
    const js=source.replace(/^src\//u,'dist/').replace(/\.ts$/u,'.js');
    await check(outputs.get(js),js,true);await check(outputs.get(js+'.map'),js+'.map',true);
    const map=JSON.parse(await readFile(path.join(coreRoot,js+'.map'),'utf8')) as {version:number;file:string;sources:string[]};
    assert.equal(map.version,3);assert.equal(map.file,path.basename(js));assert.equal(map.sources.length,1);
    assert.equal(fileURLToPath(new URL(map.sources[0]!,pathToFileURL(path.join(coreRoot,js+'.map')))),path.join(coreRoot,source));
  }
  const utility=await import(pathToFileURL(path.join(coreRoot,'dist/utility-main.js')).href) as typeof import('../../src/utility-main.js');
  const optional=await import(pathToFileURL(path.join(coreRoot,'dist/rust-core/optional-readonly-manager.js')).href) as typeof import('../../src/rust-core/optional-readonly-manager.js');
  const client=await import(pathToFileURL(path.join(coreRoot,'dist/collection/dataset-owner-client.js')).href) as typeof import('../../src/collection/dataset-owner-client.js');
  return {utility,optional,client};
}
async function until(check:()=>boolean){
  const deadline=performance.now()+10_000;
  while(!check()){
    assert.equal(performance.now()<deadline,true,'合成启动/关闭未在测试控制时限内完成');
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
}
class Port implements UtilityPort {
  readonly messages:unknown[]=[];
  listener?: (event:{data:unknown})=>void;
  on(_event:'message',listener:(event:{data:unknown})=>void){this.listener=listener;}
  start(){}
  postMessage(message:unknown){this.messages.push(message);}
  get ready(){return this.messages.some(m=>(m as {event?:string}).event==='core.ready');}
  async response(request:dto.IpcRequest):Promise<dto.IpcResponse>{
    assert.ok(this.listener);this.listener({data:request});
    await until(()=>this.messages.some(m=>(m as {id?:string}).id===request.id));
    return this.messages.find(m=>(m as {id?:string}).id===request.id) as dto.IpcResponse;
  }
  async ask<T>(command:dto.IpcCommand,payload:unknown={},datasetId?:string):Promise<T>{
    const response=await this.response({version:1,id:randomUUID(),command,payload,...(datasetId?{expectedDatasetId:datasetId}:{})});
    assert.equal(response.ok,true,`真实启动链命令 ${command} 应成功`);
    assert.ok(response.ok);return response.result as T;
  }
}
// 只在Owner自然退出以后打开合成库的只读连接，不创建第二写者。
function snapshot(file:string){
  const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});
  try{return {
    sourceRoots:db.prepare('SELECT * FROM source_roots ORDER BY rowid').all().map(r=>({...r})),
    sourceLedger:db.prepare('SELECT * FROM source_ledger ORDER BY rowid').all().map(r=>({...r})),
    catalogRoots:db.prepare('SELECT * FROM local_catalog_roots ORDER BY rowid').all().map(r=>({...r})),
    catalogLedger:db.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all().map(r=>({...r})),
  };}finally{db.close();}
}
test('MBRS003 startup：实际Utility包装与Rust OFF、Owner Worker授权关联及同command冷恢复，普通入口拒可信命令',{timeout:90_000},async t=>{
  const runtime=await freshRuntime(),fixture=await audioFixture(t);
  const data=path.join(fixture.directory,'startup-private-data'),media=path.join(fixture.directory,'startup-media');
  await mkdir(data,{mode:0o700});await mkdir(media,{mode:0o700});
  const audio=await fixture.bytes('core-wav'),mediaFile=path.join(media,'synthetic.wav');
  await writeFile(mediaFile,audio,{flag:'wx',mode:0o600});
  const mediaInfo=await lstat(mediaFile);assert.equal(mediaInfo.nlink,1);assert.equal(mediaInfo.mode&0o777,0o600);
  const descriptor=Object.getOwnPropertyDescriptor(process,'parentPort'),previousExitCode=process.exitCode;
  const exits:number[]=[];
  // 只截住Utility既有process.exit，避免退出Node测试宿主；不替换Worker关闭/退出或领域操作。
  t.mock.method(process,'exit',((code?:number|string|null)=>{exits.push(Number(code??0));return undefined as never;}) as typeof process.exit);
  t.after(()=>{if(descriptor)Object.defineProperty(process,'parentPort',descriptor);else Reflect.deleteProperty(process,'parentPort');process.exitCode=previousExitCode;});
  const authorizationCommandId=randomUUID(),registerCommandId=randomUUID();
  async function start(){
    const port=new Port(),workerExits:number[]=[];let owner!:DatasetOwnerEndpoint;
    let sourceOwner!:DatasetOwnerEndpoint,optionsCalls=0;
    const manager=runtime.optional.createOptionalRustReadonlyManager({createOptions:async()=>{optionsCalls++;throw new Error('此case不得启用Rust');}});
    let parentListener!: (event:{data:unknown;ports:UtilityPort[]})=>void;
    Object.defineProperty(process,'parentPort',{configurable:true,value:{once(_event:'message',listener:typeof parentListener){parentListener=listener;}}});
    let worker!:Worker;const beforeExits=exits.length;
    const factory:DatasetOwnerFactory=({projection,onFatal})=>{
      worker=new Worker(new URL('../helpers/dataset-owner-fixture.ts',import.meta.url),{
        execArgv:['--import','tsx'],workerData:{mode:'scan-real',dataDirectory:data},
      });
      worker.once('exit',code=>workerExits.push(code));
      sourceOwner=runtime.client.createDatasetOwnerClient({worker,projection,onFatal});
      owner=manager.decorate(sourceOwner);
      assert.equal(typeof owner.dispatchInternal,'function','原Proxy必须保留来源的真实内部能力');
      return owner;
    };
    await runtime.utility.runCoreUtilityProcess({NODE_ENV:'test',MUSIC_BRIDGE_CORE_TEST_MODE:'1',MUSIC_BRIDGE_DATA_DIRECTORY:data},undefined,undefined,undefined,null,factory);
    parentListener({data:{type:'musicbridge.core.port'},ports:[port]});
    await until(()=>port.ready||exits.length>beforeExits);
    assert.equal(port.ready,true,'必须走真实runtime.start和commitBoot');
    assert.equal(manager.getStatus().enabled,false);assert.equal(manager.getStatus().mode,'node');
    assert.equal(manager.getStatus().state,'off');assert.equal(optionsCalls,0);
    const identity:DatasetOwnerIdentity=await owner.prepare();let stopped=false;
    async function stop(){
      if(stopped)return;
      const response=await port.ask<{stopped:true}>('core.shutdown');assert.equal(response.stopped,true);
      await until(()=>exits.length>beforeExits);
      same(exits.slice(beforeExits),[0],'仅正常Utility关闭出口');same(workerExits,[0],'Owner必须实际自然exit0');
      assert.equal(worker.threadId,-1);assert.equal(optionsCalls,0);
      assert.equal(manager.getStatus().enabled,false);assert.equal(manager.getStatus().mode,'node');
      await assert.rejects(owner.dispatch({version:1,id:randomUUID(),command:'localRelocation.roots',payload:{},expectedDatasetId:identity.datasetId}));
      await assert.rejects(owner.dispatchInternal!({version:1,id:randomUUID(),command:'localRelocation.registerRoot',payload:{commandId:registerCommandId,sourceRootId:randomUUID()},expectedDatasetId:identity.datasetId}));
      stopped=true;
    }
    t.after(async()=>{if(!stopped)await stop();});
    return {port,owner,identity,manager,stop};
  }
  const first=await start();
  same(await first.port.ask('localRelocation.roots',{},first.identity.datasetId),[],'新私有音乐库初始无根');
  const authorized=await first.port.ask<dto.SourceRoot>('recordingSources.authorize',{commandId:authorizationCommandId,absolutePath:media},first.identity.datasetId);
  assert.equal(authorized.authorized,true);assert.equal(authorized.availability,'ONLINE');
  const body={commandId:registerCommandId,sourceRootId:authorized.id};
  const trusted:dto.IpcRequest={version:1,id:randomUUID(),command:'localRelocation.registerRoot',payload:body,expectedDatasetId:first.identity.datasetId};
  assert.equal(dto.validateIpcRequest(trusted).ok,false,'公开IPC不可选择可信根关联');
  assert.equal(dto.validateIpcInternalRequest(trusted).ok,true);
  await assert.rejects(first.owner.dispatch(trusted),'普通Owner入口不得受理可信命令');
  same(await first.port.ask('localRelocation.roots',{},first.identity.datasetId),[],'普通拒绝无catalog副作用');
  const root=await first.port.ask<dto.LibraryRoot>('localRelocation.registerRoot',body,first.identity.datasetId);
  assert.equal(root.sourceRootId,authorized.id);assert.equal(root.role,'library');
  const views=await first.port.ask<dto.LocalRootView[]>('localRelocation.roots',{},first.identity.datasetId);
  assert.equal(views.length,1);same(views[0]!.root,root,'公开根必须是真实内部提交结果');
  assert.equal(views[0]!.availability,'ONLINE');
  same(await first.port.ask('localRelocation.registerRoot',body,first.identity.datasetId),root,'同command重复只返回原receipt');
  same(await first.port.ask('recordingSources.roots',{},first.identity.datasetId),{roots:[authorized]},'关联不改变既有Source许可');
  await first.stop();
  const baseline=snapshot(path.join(data,'collection.v1.sqlite'));
  assert.equal(baseline.sourceRoots.length,1);assert.equal(baseline.sourceLedger.length,1);
  assert.equal(baseline.catalogRoots.length,1);assert.equal(baseline.catalogLedger.length,1);
  const row=baseline.catalogLedger[0]!;assert.equal(row.command_id,registerCommandId);assert.equal(row.operation,'register-root');
  const second=await start();assert.notEqual(second.identity.epoch,first.identity.epoch);assert.equal(second.identity.datasetId,first.identity.datasetId);
  same(await second.port.ask('recordingSources.rootReceipt',{commandId:authorizationCommandId},second.identity.datasetId),{root:authorized},'冷开保留原Source授权回执');
  same(await second.port.ask('localCatalog.receipt',{commandId:registerCommandId,operation:'register-root',fingerprint:String(row.fingerprint)},second.identity.datasetId),{
    commandId:registerCommandId,operation:'register-root',fingerprint:String(row.fingerprint),result:root,
  },'冷开公开查询精确原catalog receipt');
  same(await second.port.ask('localRelocation.registerRoot',body,second.identity.datasetId),root,'冷开同command只查原结果，不能重复创建');
  same(await second.port.ask('recordingSources.authorize',{commandId:authorizationCommandId,absolutePath:media},second.identity.datasetId),authorized,'原授权command重复保持许可');
  const coldViews=await second.port.ask<dto.LocalRootView[]>('localRelocation.roots',{},second.identity.datasetId);
  assert.equal(coldViews.length,1);same(coldViews[0]!.root,root,'冷开稳定root ID');
  const changed=await second.port.response({version:1,id:randomUUID(),command:'localRelocation.registerRoot',payload:{...body,sourceRootId:randomUUID()},expectedDatasetId:second.identity.datasetId});
  assert.equal(changed.ok,false,'同command改body不能洗掉原receipt');
  await second.stop();
  same(snapshot(path.join(data,'collection.v1.sqlite')),baseline,'冷/重复/拒绝后四表完整行与账本保持');
  assert.equal(hash(await readFile(mediaFile)),hash(audio),'独立源音频字节保持');
  await fixture.assertUnchanged();same(exits,[0,0],'两次正常生命周期出口');
});
