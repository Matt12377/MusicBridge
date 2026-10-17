import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync,
  realpathSync, writeSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStoragePolicy } from '../../apps/desktop/scripts/build-storage-root.mjs';
import { V39_INTEGRATION_TASK,V39_INTEGRATION_ARTIFACT_PROFILES,inspectV39Integration002WorkflowGuard,
 inspectV39Integration002Admission,inspectV39Integration002ReportAdmission,v39Integration002ToolRootNames,
 v39Integration002AuxiliaryRootNames,v39Integration002ArtifactPathAllowed,readV39Integration002Whole,
 v39Integration002CueNormalScanBodyRefs,encodeV39Integration002AuxiliaryContent } from './v39-integration-002-admission.mjs';
import { inspectV39Integration002NativePreparation } from './verify-v39-integration-002.mjs';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const within=(file,root)=>file.startsWith(root+path.sep);
const rawCap=16777216,totalCap=4*1024*1024*1024;
function fail(code){throw Object.assign(new Error('V3.9 当前归档拒绝。'),{code});}
const fixed=(file,storage,kind='file')=>{
 const canonical=storage.check(file,{mustExist:true,kind});const info=lstatSync(canonical);
 if(info.isSymbolicLink()||realpathSync(canonical)!==canonical||(kind==='file'?!info.isFile():!info.isDirectory()))fail('V39_002_ARTIFACT_INPUT_KIND');
 return canonical;
};
function pinRows(value,result=[]){if(value&&typeof value==='object'&&!Array.isArray(value)){
 if(typeof value.path==='string'&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&/^[a-f0-9]{64}$/u.test(value.sha256??''))result.push(value);
 for(const child of Object.values(value))pinRows(child,result);
 }else if(Array.isArray(value))for(const child of value)pinRows(child,result);return result;}
/** 只复制已选择的普通文件；高字节产物同FD分块复制/全SHA，不用无限readFile或继承runner目录。 */
export function copyV39Integration002ArtifactFile(source,destination,relative,state){
 if(!v39Integration002ArtifactPathAllowed(relative)||state.files.some(row=>row.path===relative))fail('V39_002_ARTIFACT_PATH_OR_DUPLICATE');
 if(realpathSync(source)!==source)fail('V39_002_ARTIFACT_SYMLINK');const original=lstatSync(source,{bigint:true});
 if(!original.isFile()||original.isSymbolicLink()||original.size>BigInt(totalCap)||state.expandedBytes+Number(original.size)>totalCap)fail('V39_002_ARTIFACT_BUDGET');
 const input=openSync(source,constants.O_RDONLY|constants.O_NOFOLLOW);let output;
 try{
  const before=fstatSync(input,{bigint:true});if(before.dev!==original.dev||before.ino!==original.ino)fail('V39_002_ARTIFACT_CHANGED');
  mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});const executable=(before.mode&0o111n)!==0n;
  output=openSync(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,executable?0o700:0o600);
  const sha=createHash('sha256'),chunk=Buffer.alloc(65536);let bytes=0;
  for(;;){const length=readSync(input,chunk,0,chunk.length,null);if(!length)break;bytes+=length;
   if(bytes>totalCap||state.expandedBytes+bytes>totalCap)fail('V39_002_ARTIFACT_BUDGET');sha.update(chunk.subarray(0,length));
   let at=0;while(at<length)at+=writeSync(output,chunk,at,length-at,null);}
  const after=fstatSync(input,{bigint:true}),current=lstatSync(source,{bigint:true});
  if(['dev','ino','mode','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key]||before[key]!==current[key])||BigInt(bytes)!==before.size)fail('V39_002_ARTIFACT_CHANGED');
  const row={path:relative,mode:executable?'100700':'100600',bytes,sha256:sha.digest('hex')};state.files.push(row);state.expandedBytes+=bytes;return row;
 }finally{if(output!==undefined)closeSync(output);closeSync(input);}
}
export function collectV39Integration002DeclaredTree(root,allowedExtension){
 if(realpathSync(root)!==root||!lstatSync(root).isDirectory()||lstatSync(root).isSymbolicLink())fail('V39_002_ARTIFACT_ROOT');
 const result=[];
 function visit(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name),name=path.relative(root,file).split(path.sep).join('/');
  if(!v39Integration002ArtifactPathAllowed(name)){continue;}
  if(entry.isSymbolicLink())fail('V39_002_ARTIFACT_SYMLINK');
  if(entry.isDirectory())visit(file);else if(entry.isFile()){
   if(!allowedExtension(name))fail('V39_002_ARTIFACT_UNDECLARED_RESULT');result.push({path:file,relative:name});
  }else fail('V39_002_ARTIFACT_INPUT_KIND');}}
 visit(root);return result.sort((a,b)=>a.relative<b.relative?-1:a.relative>b.relative?1:0);
}
/** 原证据正文读取：普通文件整件核SHA；缺件/漂移返回undefined供512拒绝。 */
function nativeEvidenceBody516(root,storage,deadline){const evidence=path.join(root,'evidence');return row=>{
 try{if(performance.now()>=deadline||!row||!v39Integration002ArtifactPathAllowed(row.path)||!Number.isSafeInteger(row.bytes)||row.bytes<0||!/^[a-f0-9]{64}$/u.test(row.sha256))return undefined;
  fixed(root,storage,'directory');fixed(evidence,storage,'directory');const file=path.join(evidence,row.path);if(!within(file,evidence))return undefined;
  const raw=readV39Integration002Whole(fixed(file,storage),rawCap);if(performance.now()>=deadline||raw.length!==row.bytes||createHash('sha256').update(raw).digest('hex')!==row.sha256)return undefined;return raw;
 }catch{return undefined;}};}
/** 精确追加正常链正文引用；不把currentBuild内packages行或绝对receipt递归误作Native材料。 */
function nativeNormalRefs516(root,storage,deadline){
 if(performance.now()>=deadline)fail('V39_002_ARTIFACT_WHOLE_TIMEOUT');const raw=readV39Integration002Whole(fixed(path.join(root,'native-proof.json'),storage),rawCap),proof=JSON.parse(raw);
 const refs=v39Integration002CueNormalScanBodyRefs(proof,nativeEvidenceBody516(root,storage,deadline));
 if(performance.now()>=deadline)fail('V39_002_ARTIFACT_WHOLE_TIMEOUT');return refs;
}
/** 现有正向artifact producer生成真实auxiliary frame；调用者仍须用whole ZIP成员校验消费。 */
export function collectV39Integration002NativeAuxiliaryContent(root,storage,deadline){
 if(!Number.isFinite(deadline)||performance.now()>=deadline)fail('V39_002_ARTIFACT_WHOLE_TIMEOUT');fixed(root,storage,'directory');
 const names=v39Integration002AuxiliaryRootNames('native');if(names.length!==23)fail('V39_002_ARTIFACT_AUX_ROOT_CLOSEDSET');
 const records=names.map(name=>{if(performance.now()>=deadline)fail('V39_002_ARTIFACT_WHOLE_TIMEOUT');return {path:name,bytes:readV39Integration002Whole(fixed(path.join(root,name),storage),rawCap)};}),readBody=nativeEvidenceBody516(root,storage,deadline),refs=nativeNormalRefs516(root,storage,deadline);
 for(const row of refs){const raw=readBody(row);if(raw===undefined)fail('V39_002_ARTIFACT_NORMAL_BODY_MISSING');records.push({path:'evidence/'+row.path,bytes:raw});}
 const content=encodeV39Integration002AuxiliaryContent(records,'native');if(performance.now()>=deadline)fail('V39_002_ARTIFACT_WHOLE_TIMEOUT');
 return {content,evidenceRefs:refs,rootNames:names,physicalBodyOrigin:'ACTUAL_REGULAR_FILES_FULL_BYTES_AND_SHA_NOT_MEMBER_COUNT'};
}

/** 只消费Native原currentBuild正文；不把事后Electron编译件认作原Native输出。 */
function nativeCompiledBuild516(root,storage,deadline){
 const proof=JSON.parse(readV39Integration002Whole(fixed(path.join(root,'native-proof.json'),storage),rawCap)),ref=proof.cueNormalScanEntry?.currentBuild,
  raw=nativeEvidenceBody516(root,storage,deadline)(ref);if(raw===undefined)fail('V39_002_ARTIFACT_NATIVE_BUILD_BODY');
 const build=JSON.parse(raw);if(Object.keys(build).sort().join(',')!=='cueBinding,currentOutputs,preparation,readerBinding'
  ||!Array.isArray(build.preparation?.outputs)||!Array.isArray(build.currentOutputs))fail('V39_002_ARTIFACT_NATIVE_BUILD_SHAPE');return {build,ref};
}
/** 同FD完整复制并保留纳秒mtime；不调用compiler，也不覆盖任何原件。 */
const nativeCompiledCopy516=String.raw`
import hashlib,json,os,stat,sys,time
value=json.load(sys.stdin)
source=value['source'];destination=value['destination'];expires=value['expiresAtMs'];rows=value['rows'];result=[];total=0
def check():
    if time.time()*1000>=expires: raise RuntimeError('V39_002_ARTIFACT_WHOLE_TIMEOUT')
def regular_root(root):
    info=os.lstat(root)
    if not stat.S_ISDIR(info.st_mode) or os.path.realpath(root)!=root: raise RuntimeError('V39_002_NATIVE_SNAPSHOT_ROOT')
regular_root(source);regular_root(destination)
if not rows or len({row['path'] for row in rows})!=len(rows): raise RuntimeError('V39_002_NATIVE_SNAPSHOT_INVENTORY')
for row in rows:
    check();name=row['path'];parts=name.split('/')
    if not name.startswith(('packages/contracts/dist/','packages/bridge-core/dist/')) or any(part in ('','.','..') for part in parts) or '\\' in name: raise RuntimeError('V39_002_NATIVE_SNAPSHOT_PATH')
    original=os.path.join(source,*parts);target=os.path.join(destination,*parts)
    if os.path.realpath(original)!=original: raise RuntimeError('V39_002_NATIVE_SNAPSHOT_SOURCE')
    parent=destination
    for part in parts[:-1]:
        parent=os.path.join(parent,part)
        if not os.path.exists(parent): os.mkdir(parent,0o700)
        regular_root(parent)
    info=os.lstat(original);input_fd=os.open(original,os.O_RDONLY|os.O_NOFOLLOW);output_fd=None
    try:
        before=os.fstat(input_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_dev!=info.st_dev or before.st_ino!=info.st_ino or before.st_mtime_ns!=int(row['mtimeNs']): raise RuntimeError('V39_002_NATIVE_SNAPSHOT_CHANGED')
        output_fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);sha=hashlib.sha256();length=0
        while True:
            check();chunk=os.read(input_fd,65536)
            if not chunk: break
            length+=len(chunk);total+=len(chunk)
            if length>row['bytes'] or total>value['totalCap']: raise RuntimeError('V39_002_NATIVE_SNAPSHOT_BUDGET')
            sha.update(chunk);offset=0
            while offset<len(chunk): offset+=os.write(output_fd,chunk[offset:])
        after=os.fstat(input_fd);current=os.lstat(original)
        if any(getattr(before,key)!=getattr(other,key) for key in ('st_dev','st_ino','st_mode','st_size','st_mtime_ns','st_ctime_ns') for other in (after,current)) or length!=row['bytes'] or sha.hexdigest()!=row['sha256']: raise RuntimeError('V39_002_NATIVE_SNAPSHOT_CHANGED')
        os.fsync(output_fd);os.utime(output_fd,ns=(before.st_atime_ns,before.st_mtime_ns));closed=os.fstat(output_fd)
        if closed.st_mtime_ns!=before.st_mtime_ns or closed.st_size!=length: raise RuntimeError('V39_002_NATIVE_SNAPSHOT_MTIME')
        result.append({'path':name,'bytes':length,'sha256':sha.hexdigest(),'mtimeNs':str(closed.st_mtime_ns)})
    finally:
        if output_fd is not None: os.close(output_fd)
        os.close(input_fd)
check();print(json.dumps({'files':result,'expandedBytes':total},ensure_ascii=False,separators=(',',':')))
`;
/** Native Gate自然完成后、任何Electron重编译前，仅复制原三stage全Core/Contracts闭集。 */
export async function snapshotV39Integration002NativeCompiledGraph(options,env=process.env){
 const deadline=performance.now()+90000,storage=buildStoragePolicy({env}),nativeRoot=fixed(options?.nativeRoot,storage,'directory');
 if(process.platform!=='darwin'||process.arch!=='arm64')fail('V39_002_NATIVE_ABI_REQUIRED');
 const guard=inspectV39Integration002WorkflowGuard(repository,env,{deadline});if(guard.integrationMode!=='qualified'||guard.integrationRole!=='source')fail('V39_002_ARTIFACT_CURRENT_TASK_REQUIRED');
 const before=inspectV39Integration002Admission(repository,env,{deadline}),summaryRaw=readV39Integration002Whole(fixed(path.join(nativeRoot,'summary.json'),storage),rawCap),summary=JSON.parse(summaryRaw);
 if(summary.schema!=='musicbridge.v39.integration002.native-gate.v1'||summary.passed!==true||summary.failureCode!==null||summary.sourceUnchanged!==true
  ||summary.sourceSha!==before.sourceSha||summary.scopeSha256!==before.scopeSha256||JSON.stringify(summary.sourceBefore)!==JSON.stringify(summary.sourceAfter)
  ||JSON.stringify(summary.sourceBefore?.admission)!==JSON.stringify(before))fail('V39_002_NATIVE_SNAPSHOT_GATE_NOT_CURRENT');
 const current=await inspectV39Integration002NativePreparation(before,env,deadline),{build,ref}=nativeCompiledBuild516(nativeRoot,storage,deadline);
 if(JSON.stringify(build.preparation)!==JSON.stringify(current.preparation)||JSON.stringify(build.readerBinding)!==JSON.stringify(current.readerBinding)
  ||JSON.stringify(build.cueBinding)!==JSON.stringify(current.cueBinding)||JSON.stringify(build.currentOutputs)!==JSON.stringify(current.preparation.outputs.map(row=>({path:row.path,bytes:row.bytes,sha256:row.sha256}))))fail('V39_002_NATIVE_SNAPSHOT_BUILD_CHANGED');
 const destination=storage.check(options.outputRoot);if(existsSync(destination)||realpathSync(path.dirname(destination))!==path.dirname(destination)||destination===repository||within(destination,repository))fail('V39_002_ARTIFACT_FRESH_ROOT');
 const rows=current.preparation.outputs.map(row=>({...row,mtimeNs:lstatSync(path.join(repository,row.path),{bigint:true}).mtimeNs.toString()}));
 mkdirSync(destination,{mode:0o700});const remaining=deadline-performance.now(),copyStartedAtMs=Date.now();if(remaining<=0)fail('V39_002_ARTIFACT_WHOLE_TIMEOUT');
 const copied=spawnSync('python3',['-c',nativeCompiledCopy516],{env,input:JSON.stringify({source:repository,destination,expiresAtMs:Date.now()+remaining,rows,totalCap}),encoding:'utf8',timeout:Math.max(1,Math.floor(remaining)),maxBuffer:rawCap,killSignal:'SIGKILL'});
 for(const [name,raw]of [['native-snapshot-copy.stdout.log',copied.stdout??''],['native-snapshot-copy.stderr.log',copied.stderr??''],
  ['native-snapshot-copy.json',JSON.stringify({startedAtMs:copyStartedAtMs,finishedAtMs:Date.now(),exitCode:copied.status,signal:copied.signal,errorCode:copied.error?.code??null})+'\n']])writeFileSync(path.join(nativeRoot,name),raw,{flag:'wx',mode:0o600});
 if(copied.error||copied.signal||copied.status!==0||performance.now()>=deadline)fail('V39_002_NATIVE_SNAPSHOT_COPY_FAILED');
 const copyRecord=JSON.parse(copied.stdout);if(JSON.stringify(copyRecord.files)!==JSON.stringify(rows.map(row=>({path:row.path,bytes:row.bytes,sha256:row.sha256,mtimeNs:row.mtimeNs})))
  ||copyRecord.expandedBytes!==rows.reduce((sum,row)=>sum+row.bytes,0))fail('V39_002_NATIVE_SNAPSHOT_COPY_PROOF');
 for(const row of rows){if(performance.now()>=deadline)fail('V39_002_ARTIFACT_WHOLE_TIMEOUT');const file=fixed(path.join(destination,row.path),storage),raw=readV39Integration002Whole(file,rawCap),info=lstatSync(file,{bigint:true});
  if(raw.length!==row.bytes||createHash('sha256').update(raw).digest('hex')!==row.sha256||info.mtimeNs.toString()!==row.mtimeNs||lstatSync(file).mtimeMs!==row.mtimeMs)fail('V39_002_NATIVE_SNAPSHOT_COPY_CHANGED');}
 const afterPreparation=await inspectV39Integration002NativePreparation(before,env,deadline),after=inspectV39Integration002Admission(repository,env,{deadline});
 if(JSON.stringify(current)!==JSON.stringify(afterPreparation)||JSON.stringify(before)!==JSON.stringify(after)
  ||!summaryRaw.equals(readV39Integration002Whole(fixed(path.join(nativeRoot,'summary.json'),storage),rawCap))
  ||JSON.stringify({build,ref})!==JSON.stringify(nativeCompiledBuild516(nativeRoot,storage,deadline)))fail('V39_002_NATIVE_SNAPSHOT_SOURCE_CHANGED');
 const manifest={schema:'musicbridge.v39.integration002.native-compiled-snapshot.v1',sourceSha:before.sourceSha,scopeSha256:before.scopeSha256,
  timeBasis:'fresh-native-preparation-run',nativeCurrentBuild:ref,originalPreparationReceipt:current.originalPreparationReceipt,
  originalSingleCompilerIntervalsRetained:true,compilerOrPreparationRerun:false,receiptOrBindingsOverwritten:false,coreCompiledRoot:destination,
  layout:'FULL_REPOSITORY_RELATIVE_CONTRACTS_AND_CORE_COMPILED_GRAPH',outputs:rows,expandedBytes:copyRecord.expandedBytes};
 const raw=Buffer.from(JSON.stringify(manifest,null,2)+'\n');if(raw.length>rawCap||performance.now()>=deadline)fail('V39_002_ARTIFACT_WHOLE_TIMEOUT');
 writeFileSync(path.join(nativeRoot,'native-compiled-snapshot.json'),raw,{flag:'wx',mode:0o600});return manifest;
}

export function selectV39Integration002ArtifactFiles(options,storage,deadline=performance.now()+90000){
 const selected=[],missing=[];const add=(file,name,required=true)=>{if(!existsSync(file)){if(required)missing.push(name);return;}
  fixed(file,storage);if(!v39Integration002ArtifactPathAllowed(name))fail('V39_002_ARTIFACT_PATH');selected.push({path:file,relative:name});};
 const roots=(directory,names,prefix='')=>{if(!directory){missing.push(prefix+'ROOT');return;}fixed(directory,storage,'directory');for(const name of names)add(path.join(directory,name),prefix+name);};
 if(options.profile==='verify-source'||options.profile==='verify-report'){
  roots(options.softwareRoot,v39Integration002ToolRootNames(options.profile==='verify-source'?'source':'report'));
  if(options.profile==='verify-source'){
   roots(options.capacityRoot,v39Integration002AuxiliaryRootNames('capacity'),'capacity/');
   if(options.capacityRoot)proof(options.capacityRoot,'capacity');
  }
 }else if(options.profile==='electron-source'){
  roots(options.nativeRoot,v39Integration002AuxiliaryRootNames('native'),'native/');if(options.nativeRoot)proof(options.nativeRoot,'native');
  if(options.nativeRoot)for(const name of ['native-compiled-snapshot.json','native-snapshot-copy.json','native-snapshot-copy.stdout.log','native-snapshot-copy.stderr.log'])add(path.join(options.nativeRoot,name),'native/'+name,false);
  if(!options.electronRoot)missing.push('electron/ROOT');else{
   fixed(options.electronRoot,storage,'directory');
   for(const name of ['electron-gates.log','electron-e2e.log'])add(path.join(options.electronRoot,name),'electron/'+name);
   const resultRoot=path.join(options.electronRoot,'results');if(existsSync(resultRoot))for(const row of collectV39Integration002DeclaredTree(resultRoot,
     name=>/\.(?:json|log|md|txt|png|webm|sqlite|db)(?:-(?:wal|shm))?$/iu.test(name)))add(row.path,'electron/results/'+row.relative);
  }
  if(options.compiledRoot){fixed(options.compiledRoot,storage,'directory');for(const row of collectV39Integration002DeclaredTree(options.compiledRoot,
    name=>/\.(?:js|mjs|cjs|map|json|html|css|woff2?|ttf|png|svg|ico)$/iu.test(name)))add(row.path,'compiled/'+row.relative);}
  else missing.push('compiled/ROOT');
  if(options.coreCompiledRoot&&existsSync(options.coreCompiledRoot)){fixed(options.coreCompiledRoot,storage,'directory');if(!options.nativeRoot)fail('V39_002_NATIVE_SNAPSHOT_GRAPH_REQUIRED');
   const {build}=nativeCompiledBuild516(options.nativeRoot,storage,deadline),declared=build.preparation.outputs,current=build.currentOutputs,
    graph=collectV39Integration002DeclaredTree(options.coreCompiledRoot,name=>/\.(?:js|mjs|cjs|map|json|d\.ts)$/iu.test(name));
   if(!declared.length||new Set(declared.map(row=>row.path)).size!==declared.length||JSON.stringify(graph.map(row=>row.relative).sort())!==JSON.stringify(declared.map(row=>row.path).sort())
    ||JSON.stringify(current)!==JSON.stringify(declared.map(row=>({path:row.path,bytes:row.bytes,sha256:row.sha256}))))fail('V39_002_NATIVE_SNAPSHOT_GRAPH_REQUIRED');
   for(const row of graph){if(performance.now()>=deadline)fail('V39_002_ARTIFACT_WHOLE_TIMEOUT');const expected=declared.find(item=>item.path===row.relative),raw=readV39Integration002Whole(fixed(row.path,storage),rawCap);
    if(!/^(?:packages\/contracts\/dist\/|packages\/bridge-core\/dist\/)/u.test(row.relative)||raw.length!==expected.bytes||createHash('sha256').update(raw).digest('hex')!==expected.sha256
     ||lstatSync(row.path).mtimeMs!==expected.mtimeMs)fail('V39_002_NATIVE_SNAPSHOT_GRAPH_CHANGED');add(row.path,'compiled-core/'+row.relative);}}
  else missing.push('compiled-core/ROOT');
 }else if(options.profile==='rust-linux-source'||options.profile==='rust-macos-source'){
  if(!options.rustRoot)missing.push('rust/ROOT');else{fixed(options.rustRoot,storage,'directory');for(const row of collectV39Integration002DeclaredTree(options.rustRoot,
    name=>/\.(?:json|log)$/u.test(name)))add(row.path,'rust/'+row.relative);}
 }else if(options.profile==='rust-host-source'){
  if(!Array.isArray(options.declaredFiles)||!options.declaredFiles.length)missing.push('host/DECLARED_FILES');
  else for(const row of options.declaredFiles){if(!row||Object.keys(row).sort().join(',')!=='path,relative'||typeof row.relative!=='string')fail('V39_002_ARTIFACT_HOST_DECLARATION');
   add(row.path,'host/'+row.relative);}
 }else fail('V39_002_ARTIFACT_PROFILE');
 function proof(root,kind){const file=path.join(root,kind+'-proof.json');if(!existsSync(file))return;
  const record=JSON.parse(readV39Integration002Whole(fixed(file,storage),rawCap));const evidence=path.join(root,'evidence');
  const refs=pinRows(record);if(kind==='native')refs.push(...nativeNormalRefs516(root,storage,deadline));const unique=new Map();for(const row of refs){const previous=unique.get(row.path);if(previous&&(previous.bytes!==row.bytes||previous.sha256!==row.sha256))fail('V39_002_ARTIFACT_PROOF_PIN_DRIFT');unique.set(row.path,row);}
  for(const row of unique.values()){if(performance.now()>=deadline)fail('V39_002_ARTIFACT_WHOLE_TIMEOUT');if(!v39Integration002ArtifactPathAllowed(row.path))fail('V39_002_ARTIFACT_PROOF_PATH');
   const file=path.join(evidence,row.path);if(!within(file,evidence))fail('V39_002_ARTIFACT_PROOF_PATH');const raw=readV39Integration002Whole(fixed(file,storage),rawCap);
   if(raw.length!==row.bytes||createHash('sha256').update(raw).digest('hex')!==row.sha256)fail('V39_002_ARTIFACT_PROOF_BYTES');
   if(!selected.some(item=>item.relative===kind+'/evidence/'+row.path))add(file,kind+'/evidence/'+row.path);}
 }
 if(new Set(selected.map(row=>row.relative)).size!==selected.length)fail('V39_002_ARTIFACT_DUPLICATE');return {selected,missing};
}
export function prepareV39Integration002Artifacts(options,env=process.env,directory=repository){
 if(!V39_INTEGRATION_ARTIFACT_PROFILES.includes(options?.profile))fail('V39_002_ARTIFACT_PROFILE');const deadline=performance.now()+90000;
 const outputs=inspectV39Integration002WorkflowGuard(directory,env,{deadline});if(outputs.integrationMode!=='qualified')fail('V39_002_ARTIFACT_CURRENT_TASK_REQUIRED');
 const before=outputs.integrationRole==='source'?inspectV39Integration002Admission(directory,env,{deadline}):inspectV39Integration002ReportAdmission(directory,env,{deadline});
 if((options.profile==='verify-report')!==(before.repairRole==='report'))fail('V39_002_ARTIFACT_ROLE');
 const storage=buildStoragePolicy({env}),root=storage.check(options.outputRoot);if(existsSync(root)||realpathSync(path.dirname(root))!==path.dirname(root))fail('V39_002_ARTIFACT_FRESH_ROOT');
 const {selected,missing}=selectV39Integration002ArtifactFiles(options,storage,deadline);mkdirSync(root,{mode:0o700});const state={files:[],expandedBytes:0};
 for(const row of selected){if(performance.now()>=deadline)fail('V39_002_ARTIFACT_WHOLE_TIMEOUT');copyV39Integration002ArtifactFile(row.path,path.join(root,row.relative),row.relative,state);}
 // fixed23 roots不变；frame作为额外声明文件保留，whole ZIP消费者从此实字节提取auxiliaryContents。
 if(options.profile==='electron-source'&&missing.length===0){const native=collectV39Integration002NativeAuxiliaryContent(path.join(root,'native'),storage,deadline),raw=Buffer.from(JSON.stringify(native.content)+'\n'),relative='native/auxiliary-content.json';
  if(raw.length>rawCap||state.expandedBytes+raw.length>totalCap||state.files.some(row=>row.path===relative))fail('V39_002_ARTIFACT_AUX_CONTENT_BUDGET');
  writeFileSync(path.join(root,relative),raw,{flag:'wx',mode:0o600});state.files.push({path:relative,mode:'100600',bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')});state.expandedBytes+=raw.length;
  if(performance.now()>=deadline)fail('V39_002_ARTIFACT_WHOLE_TIMEOUT');}
 const after=before.repairRole==='source'?inspectV39Integration002Admission(directory,env,{deadline}):inspectV39Integration002ReportAdmission(directory,env,{deadline});
 if(JSON.stringify(before)!==JSON.stringify(after))fail('V39_002_ARTIFACT_SOURCE_CHANGED');
 const manifest={schema:'musicbridge.v39.integration002.archive-manifest.v1',task:V39_INTEGRATION_TASK,profile:options.profile,
  sourceSha:before.sourceSha,head:before.headAtAdmission,scopeSha256:before.scopeSha256,cachePolicy:'DECLARED_POSITIVE_FILES_ONLY',
  sourceBefore:before,sourceAfter:after,files:state.files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),expandedBytes:state.expandedBytes,
  missingDeclaredFiles:missing,completeDeclaredProfile:missing.length===0,sourceSoftwareQualification:'NOT_GRANTED_BY_ARCHIVE_PREPARATION'};
 const raw=Buffer.from(JSON.stringify(manifest,null,2)+'\n');if(raw.length>rawCap)fail('V39_002_ARTIFACT_MANIFEST_BUDGET');
 writeFileSync(path.join(root,'archive-manifest.json'),raw,{flag:'wx',mode:0o600});return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const options={},flags={'--profile':'profile','--output-root':'outputRoot','--software-root':'softwareRoot','--capacity-root':'capacityRoot',
  '--native-root':'nativeRoot','--electron-root':'electronRoot','--compiled-root':'compiledRoot','--core-compiled-root':'coreCompiledRoot','--rust-root':'rustRoot','--declared-files':'declaredFiles'};
  const args=process.argv.slice(2);if(args.length%2)fail('V39_002_ARTIFACT_ARGUMENT');for(let i=0;i<args.length;i+=2){const key=flags[args[i]];
   if(!key||Object.hasOwn(options,key))fail('V39_002_ARTIFACT_ARGUMENT');options[key]=key==='declaredFiles'?JSON.parse(readV39Integration002Whole(args[i+1])):args[i+1];}
  if(!options.outputRoot||!options.profile)fail('V39_002_ARTIFACT_ARGUMENT');const result=prepareV39Integration002Artifacts(options);
  process.stdout.write(JSON.stringify({profile:result.profile,files:result.files.length,expandedBytes:result.expandedBytes,completeDeclaredProfile:result.completeDeclaredProfile})+'\n');
  if(!result.completeDeclaredProfile)process.exitCode=1;
 }catch(error){process.stderr.write((/^[A-Z0-9_]+$/u.test(error?.code??'')?error.code:'V39_002_ARTIFACT_FAILED')+'\n');process.exitCode=1;}}
