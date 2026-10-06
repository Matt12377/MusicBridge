/** 固定Worker产物校验；只读代码和构建元数据，不加载Reader或parser。 */
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
export const WORKER_ENTRY = 'dist/library/metadata-reader-worker.bundle.mjs';
export const ROOT_INPUTS = [
  'src/recording/source-files.ts','src/library/metadata-reader.ts',
  'src/library/metadata-reader-worker.ts','src/library/metadata-reader-types.ts',
  'src/library/metadata-reader-runtime.ts','scripts/build-metadata-reader-worker.mjs',
  'scripts/metadata-reader-bundle-artifacts.mjs','scripts/metadata-reader-bundle-artifacts.d.mts',
  'package.json','../../pnpm-lock.yaml','../../apps/desktop/scripts/build-storage-root.mjs',
];
export const LOADER_FILES = ['aiff/AiffLoader.js','apev2/Apev2Loader.js','asf/AsfLoader.js',
  'dsdiff/DsdiffLoader.js','dsf/DsfLoader.js','flac/FlacLoader.js','matroska/MatroskaLoader.js',
  'mp4/Mp4Loader.js','mpeg/MpegLoader.js','musepack/MusepackLoader.js','ogg/OggLoader.js',
  'wav/WaveLoader.js','wavpack/WavPackLoader.js'];
const builtin = new Set(builtinModules.flatMap(n=>[n,n.startsWith('node:')?n:'node:'+n]));
const fail = () => { throw new Error('固定Metadata Worker构建身份未满足。'); };
const digest = b => createHash('sha256').update(b).digest('hex');
const id = x => x && typeof x.file === 'string' && Number.isSafeInteger(x.bytes) && x.bytes > 0 && /^[a-f0-9]{64}$/.test(x.sha256);
const exactSet = (xs,ys) => Array.isArray(xs) && xs.length === ys.length && new Set(xs).size === xs.length && xs.every(x=>ys.includes(x));
/** 仅附加原始输入的可核调试map；执行语句不变，不消费未安装的上游源码。 */
export function fixedMetadataBuildSource(text,file) {
  if(file.endsWith('.json') || !text.includes('sourceMappingURL='))return text;
  const lines=text.split('\n').length;
  const identityMap={version:3,file:path.basename(file),sourceRoot:'',sources:[path.basename(file)],
    sourcesContent:[text],names:[],mappings:Array.from({length:lines},(_,i)=>i===0?'AAAA':'AACA').join(';')};
  return text+'\n//# sourceMappingURL=data:application/json;base64,'+Buffer.from(JSON.stringify(identityMap)).toString('base64')+'\n';
}
export function validateFixedWorkerReceiptShape(v) {
  if (!v || v.schema !== 'mbrs003.metadata-worker.fixed-bundle.v2' || v.status !== 'FRESH_FIXED_WORKER_BUNDLE_BUILT'
    || v.entry?.file !== WORKER_ENTRY || v.map?.file !== WORKER_ENTRY+'.map'
    || v.metafile?.file !== 'dist/library/metadata-reader-worker.bundle.meta.json'
    || ![v.entry,v.map,v.metafile].every(id) || v.esbuildVersion !== '0.28.2' || v.nodeMajor !== 22
    || v.format !== 'esm' || v.platform !== 'node' || v.splitting !== false
    || !Array.isArray(v.builtinExternals) || !v.builtinExternals.length || !v.builtinExternals.every(x=>builtin.has(x))
    || !Number.isFinite(v.startedAtMs) || v.startedAtMs <= 0 || !Number.isFinite(v.finishedAtMs) || v.finishedAtMs < v.startedAtMs
    || !exactSet(v.rootInputs?.map(x=>x.file),ROOT_INPUTS) || !v.rootInputs.every(id)
    || !Array.isArray(v.loadedInputs) || !v.loadedInputs.length || v.loadedInputs.length>2048 || !v.loadedInputs.every(id)
    || new Set(v.loadedInputs.map(x=>x.file)).size !== v.loadedInputs.length
    || !Array.isArray(v.packageInputs) || !v.packageInputs.length || !v.packageInputs.every(id)
    || !Array.isArray(v.toolInputs) || v.toolInputs.length!==3 || !v.toolInputs.every(id)
    || typeof v.metadataEntry !== 'string' || typeof v.eofEntry !== 'string' || typeof v.eofClass !== 'string'
    || !path.isAbsolute(v.metadataEntry) || !path.isAbsolute(v.eofEntry) || !path.isAbsolute(v.eofClass)
    || v.eofEntry !== v.metadataDependencyEofEntry
    || v.loadedInputs.filter(x=>x.file===v.eofClass).length!==1
    || !exactSet(v.loaderFiles,LOADER_FILES) || v.readerV1Binding !== false || v.runtimeValidationClaim !== false
    || v.scalePass !== false || v.whole003Pass !== false) fail();
  if (!v.loaderFiles.every(f=>v.loadedInputs.some(x=>x.file===path.join(path.dirname(v.metadataEntry),f)))) fail();
  return v;
}
/** 每块读取、SHA和stat均核用户态预算；finally关闭，不声称可抢占kernel I/O。 */
export async function readArtifact(p,check=()=>{}) {
  check(); const cp=await realpath(p);check();if(cp!==p)fail();
  const before=await lstat(p,{bigint:true});check();if(!before.isFile() || before.isSymbolicLink() || before.size<1n || before.size>16n*1024n*1024n)fail();
  const shape=s=>['dev','ino','mode','nlink','uid','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
  const h=await open(p,'r');let bytes;
  try {
    const st=await h.stat({bigint:true});check();if(shape(st)!==shape(before))fail();
    const chunks=[];let at=0;
    while(at<Number(st.size)) { check();const b=Buffer.alloc(Math.min(1024*1024,Number(st.size)-at));const r=await h.read(b,0,b.length,at);check();if(!r.bytesRead)fail();chunks.push(b.subarray(0,r.bytesRead));at+=r.bytesRead; }
    bytes=Buffer.concat(chunks);check();if(shape(await h.stat({bigint:true}))!==shape(st))fail();check();
  } finally { await h.close(); }
  if(shape(await lstat(p,{bigint:true}))!==shape(before))fail();check();
  const sha=digest(bytes);check();return {bytes,identity:{file:p,bytes:bytes.length,sha256:sha},mtimeMs:Number(before.mtimeNs)/1e6};
}
export async function readFixedMetadataWorkerBundle(coreRoot,check=()=>{}) {
  check();if(!path.isAbsolute(coreRoot) || await realpath(coreRoot)!==coreRoot)fail();check();
  const receiptFile=path.join(coreRoot,'dist/library/metadata-reader-worker.bundle.build.json');
  const raw=await readArtifact(receiptFile,check);const v=validateFixedWorkerReceiptShape(JSON.parse(raw.bytes.toString('utf8')));
  const verify=async (r,p,fresh=false)=>{
    const x=await readArtifact(p,check);if(x.identity.bytes!==r.bytes || x.identity.sha256!==r.sha256 || fresh&&(x.mtimeMs<v.startedAtMs || x.mtimeMs>v.finishedAtMs))fail();return x;
  };
  for(const r of v.rootInputs)await verify(r,path.resolve(coreRoot,r.file));
  const actualBuildInputBytes=new Map();
  for(const r of [...v.loadedInputs,...v.packageInputs,...v.toolInputs]){
    if(!path.isAbsolute(r.file) || !/\.(?:ts|js|mjs|cjs|json|d\.mts)$/.test(r.file) && !r.file.endsWith('/bin/esbuild'))fail();
    const actual=await verify(r,r.file);
    if(v.loadedInputs.includes(r))actualBuildInputBytes.set(r.file,Buffer.byteLength(fixedMetadataBuildSource(actual.bytes.toString('utf8'),r.file)));check();
  }
  const entry=await verify(v.entry,path.join(coreRoot,WORKER_ENTRY),true);
  const map=await verify(v.map,path.join(coreRoot,WORKER_ENTRY+'.map'),true);
  const meta=await verify(v.metafile,path.join(coreRoot,v.metafile.file),true);
  const m=JSON.parse(map.bytes.toString('utf8'));if(!Array.isArray(m.sources) || m.sources.length<2 || !Array.isArray(m.sourcesContent) || m.sources.length!==m.sourcesContent.length)fail();
  const graph=JSON.parse(meta.bytes.toString('utf8'));
  const loaded=new Map(v.loadedInputs.map(r=>[r.file,r]));
  for(let i=0;i<m.sources.length;i++){
    check();if(typeof m.sources[i]!=='string' || typeof m.sourcesContent[i]!=='string')fail();
    const p=path.resolve(path.dirname(path.join(coreRoot,WORKER_ENTRY+'.map')),m.sources[i]);
    const r=loaded.get(p),content=Buffer.from(m.sourcesContent[i]);
    if(!r || content.length!==r.bytes || digest(content)!==r.sha256)fail();check();
  }
  if(!graph.outputs || !exactSet(Object.keys(graph.outputs).map(f=>path.resolve(coreRoot,f)),[path.join(coreRoot,WORKER_ENTRY),path.join(coreRoot,WORKER_ENTRY+'.map')]))fail();
  const entryOutput=Object.entries(graph.outputs).find(([f])=>path.resolve(coreRoot,f)===path.join(coreRoot,WORKER_ENTRY))?.[1];
  if(!entryOutput?.entryPoint || path.resolve(coreRoot,entryOutput.entryPoint)!==path.join(coreRoot,'src/library/metadata-reader-worker.ts'))fail();
  if(!graph.inputs || typeof graph.inputs!=='object' || Array.isArray(graph.inputs))fail();
  // esbuild metafile的输入key及内部import路径均相对absWorkingDir（coreRoot），不是importer目录。
  const normalizedInputs=Object.keys(graph.inputs).map(f=>path.resolve(coreRoot,f));
  if(!exactSet(normalizedInputs,[...loaded.keys()]))fail();
  const workerSource=path.join(coreRoot,'src/library/metadata-reader-worker.ts');
  if(!loaded.has(workerSource) || !normalizedInputs.includes(workerSource))fail();
  for(const [f,row]of Object.entries(graph.inputs)) {
    check();const p=path.resolve(coreRoot,f);
    if(!row || actualBuildInputBytes.get(p)!==row.bytes || !Array.isArray(row.imports))fail();
    for(const edge of row.imports){
      check();if(!edge || typeof edge.path!=='string')fail();
      if(edge.external===true){if(!builtin.has(edge.path) || !v.builtinExternals.includes(edge.path))fail();}
      else {if(edge.external!==undefined && edge.external!==false)fail();if(!loaded.has(path.resolve(coreRoot,edge.path)))fail();}
    }
  }
  for(const out of Object.values(graph.outputs))for(const edge of out.imports){if(!edge.external || !builtin.has(edge.path) || !v.builtinExternals.includes(edge.path))fail();}
  return {manifest:v,entryBytes:entry.bytes,mapBytes:map.bytes,receiptRef:{file:receiptFile,bytes:raw.bytes.length,sha256:raw.identity.sha256}};
}
