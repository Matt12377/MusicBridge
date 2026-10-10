import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, readdirSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStoragePolicy } from '../../apps/desktop/scripts/build-storage-root.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha = b => createHash('sha256').update(b).digest('hex');
const stable = (a,b) => ['dev','ino','size','mtimeNs','ctimeNs'].every(k => a[k] === b[k]);
const testNames = ['processing-negotiation','dsd-resource-state','resource-continuity-lossless'];
function whole(file) {
  if (realpathSync(file) !== file) throw new Error('003合同输入不能沿符号链。');
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const a=fstatSync(fd,{bigint:true});if(!a.isFile()||a.size<1n||a.size>16n*1024n*1024n)throw new Error('003合同文件超限或非普通文件。');
    const b=Buffer.alloc(Number(a.size));let at=0;while(at<b.length){const n=readSync(fd,b,at,b.length-at,null);if(!n)throw new Error('003合同输入截短。');at+=n;}
    const extra=Buffer.alloc(1);if(readSync(fd,extra,0,1,null)||!stable(a,fstatSync(fd,{bigint:true}))||!stable(a,lstatSync(file,{bigint:true})))throw new Error('003合同输入完整读取时漂移。');
    return {bytes:b,stat:a};
  } finally {closeSync(fd);}
}
const identity = p => {const b=whole(path.join(root,p)).bytes;return{path:p,bytes:b.length,sha256:sha(b)};};
function inputs() {
  const names=new Set(['packages/contracts/package.json','packages/contracts/tsconfig.json','packages/contracts/tsconfig.test.json',
    'packages/contracts/mobile/openapi.json','docs/postrust/MBM-003/CONTRACT_SEMANTICS.md','docs/postrust/MBM-003/CONTRACT_FREEZE.json',
    'docs/postrust/MBM-003/READY_RENEW_BOUNDARY.json','pnpm-lock.yaml','scripts/ci/mbm003-contract-gate.mjs']);
  function walk(p){const s=lstatSync(path.join(root,p));if(s.isSymbolicLink())throw new Error('003合同源不能沿符号链。');
    if(s.isDirectory())for(const n of readdirSync(path.join(root,p)).sort())walk(p+'/'+n);else if(s.isFile())names.add(p);}
  for(const p of ['packages/contracts/src','packages/contracts/test'])walk(p);
  if(names.size>4096)throw new Error('003合同输入数超限。');return [...names].sort().map(identity);
}
async function run(name,args,cwd,env,out) {
  const startedMs=Date.now(), child=spawn(process.execPath,args,{cwd,env,stdio:['ignore','pipe','pipe']});
  const chunks=[];let bytes=0,timedOut=false,overflow=false,error;
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{bytes+=b.length;if(bytes>16*1024*1024){overflow=true;child.kill('SIGKILL');}else chunks.push(b);});
  child.once('error',e=>{error=e;});const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},120_000);
  const closed=await new Promise(resolve=>child.once('close',(exitCode,signal)=>resolve({exitCode,signal})));
  clearTimeout(timer);const closedMs=Date.now();writeFileSync(path.join(out,name+'.log'),Buffer.concat(chunks),{flag:'wx',mode:0o600});
  const row={name,startedMs,closedMs,...closed,closeObserved:true,timedOut,overflow,captureFailed:false,preparationFailed:!!error,groupTerminationFailed:false};
  if(error||timedOut||overflow||row.exitCode!==0||row.signal!==null){const e=new Error('003合同阶段失败：'+name);e.stage=row;throw e;}return row;
}
/** 只封存实际新合同编译与消费；不能写成Core/cache/App/真机或Owner PASS。 */
export async function runMbm003ContractGate(outputRoot,{env=process.env}={}) {
  if(process.versions.node.split('.')[0]!=='22')throw new Error('003合同Gate要求Node22。');
  const storage=buildStoragePolicy({env}),out=storage.check(outputRoot);mkdirSync(out,{mode:0o700});storage.check(out,{mustExist:true});
  const consumed=path.join(out,'consumed');mkdirSync(consumed,{mode:0o700});const temporary=path.join(out,'tmp');mkdirSync(temporary,{mode:0o700});
  const before=inputs(),same=()=>{if(JSON.stringify(inputs())!==JSON.stringify(before))throw new Error('003合同构建/消费输入漂移。');};
  const canonical=whole(path.join(root,'packages/contracts/mobile/openapi.json')).bytes;
  if(canonical.length!==147445||sha(canonical)!=='3deaa9e238f24b7062945efacc775b604a60a5652b837b8c46378f0b89eeec21')throw new Error('003实际共同采纳合同身份已变。');
  const req=createRequire(path.join(root,'packages/contracts/package.json')),tsc=req.resolve('typescript/bin/tsc');
  const bindingFile=path.join(out,'binding.json'),childEnv={...env,TMPDIR:temporary,MBM003_CONTRACT_BUILD_BINDING:bindingFile,MBM003_CONTRACT_CONSUMPTION_ROOT:consumed};
  const stages=[];let binding;
  try {
    const compiler=await run('fresh-contracts-build',[tsc,'-p','tsconfig.json'],path.join(root,'packages/contracts'),childEnv,out);stages.push(compiler);same();
    const artifacts=[];
    for(const source of before.filter(x=>/^packages\/contracts\/src\/.*\.ts$/u.test(x.path)&&!x.path.endsWith('.d.ts')))
      for(const suffix of ['.js','.js.map','.d.ts']){const relativePath=source.path.replace('/src/','/dist/').slice(0,-3)+suffix,file=path.join(root,relativePath),x=whole(file);
        const mtimeMs=Number(x.stat.mtimeNs)/1e6;if(mtimeMs<compiler.startedMs||mtimeMs>compiler.closedMs)throw new Error('003产物不属于本轮实际编译。');
        artifacts.push({file,relativePath,sourcePath:source.path,sourceSha256:source.sha256,bytes:x.bytes.length,sha256:sha(x.bytes),mtimeMs,mtimeNs:String(x.stat.mtimeNs)});}
    const projection=artifacts.map(({relativePath,bytes,sha256})=>({relativePath,bytes,sha256})).sort((a,b)=>a.relativePath<b.relativePath?-1:a.relativePath>b.relativePath?1:0);
    const head=await new Promise((resolve,reject)=>{let b='';const c=spawn('/usr/bin/git',['rev-parse','HEAD'],{cwd:root,stdio:['ignore','pipe','pipe']});c.stdout.on('data',x=>b+=x);c.on('error',reject);c.on('close',(e,s)=>e===0&&s===null?resolve(b.trim()):reject(new Error('003HEAD读取失败。')));});
    binding={schema:'musicbridge.mbm003.fresh-contracts-binding.v1',root,head,predecessor:'b1a8de728086e7994bb69d7dee10782f646886dd',inputs:before,
      compiler:Object.fromEntries(Object.entries(compiler).filter(([k])=>k!=='name')),artifacts,artifactIdentity:sha(Buffer.from(JSON.stringify(projection)))};
    writeFileSync(bindingFile,JSON.stringify(binding)+'\n',{flag:'wx',mode:0o600});
    stages.push(await run('contracts-types',[tsc,'-p','tsconfig.test.json','--noEmit'],path.join(root,'packages/contracts'),childEnv,out));same();
    stages.push(await run('contracts-behavior',['--import','tsx','--test','--test-concurrency=1','--test-reporter=tap',...testNames.map(n=>'test/mbm003/'+n+'.test.ts')],path.join(root,'packages/contracts'),childEnv,out));same();
    const names=readdirSync(consumed).sort(),expected=testNames.map(n=>n+'.test.ts.json').sort();if(JSON.stringify(names)!==JSON.stringify(expected))throw new Error('003合同消费收据未闭合。');
    for(const n of names){const row=JSON.parse(whole(path.join(consumed,n)).bytes.toString('utf8'));
      if(row.schema!=='musicbridge.mbm003.contract-consumption.v1'||row.bindingSha256!==sha(whole(bindingFile).bytes)||row.artifactIdentity!==binding.artifactIdentity)throw new Error('003合同实际消费身份不符。');}
    for(const row of artifacts){const x=whole(row.file);if(x.bytes.length!==row.bytes||sha(x.bytes)!==row.sha256||String(x.stat.mtimeNs)!==row.mtimeNs)throw new Error('003合同编译产物漂移。');}
    const result={schema:'musicbridge.mbm003.contract-gate.v1',state:'CONTRACT_SOFTWARE_ONLY_PASS',stages,inputIdentity:sha(Buffer.from(JSON.stringify(before))),artifactIdentity:binding.artifactIdentity,
      actualContractsConsumed:true,topLevelCases:27,coreCacheAppDeviceOwnerAcceptance:'NOT_PROVEN_BY_THIS_CONTRACT_SLICE'};
    writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
  } catch(error){writeFileSync(path.join(out,'result.json'),JSON.stringify({schema:'musicbridge.mbm003.contract-gate.v1',state:'FAILED',stages,failedStage:error.stage??null,error:error.message},null,2)+'\n',{flag:'wx',mode:0o600});throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);if(args.length!==1||!args[0].startsWith('--output-root='))throw new Error('用法：node scripts/ci/mbm003-contract-gate.mjs --output-root=批准的独立新目录');
  const result=await runMbm003ContractGate(args[0].slice('--output-root='.length));console.log(JSON.stringify({state:result.state,topLevelCases:result.topLevelCases}));
}
