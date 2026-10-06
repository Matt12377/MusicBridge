/** 仅build时调用；不加载Worker/parser，不执行扫描。 */
import { builtinModules,createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import { readFile,writeFile,rename,mkdir,lstat,realpath } from 'node:fs/promises';
import { fileURLToPath,pathToFileURL } from 'node:url';
import path from 'node:path';
import { ROOT_INPUTS,LOADER_FILES,WORKER_ENTRY,readArtifact,readFixedMetadataWorkerBundle,fixedMetadataBuildSource } from './metadata-reader-bundle-artifacts.mjs';
const coreRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const same=(a,b)=>a.bytes===b.bytes&&a.sha256===b.sha256;
export async function buildFixedMetadataWorkerBundle() {
  if(process.versions.node.split('.')[0]!=='22' || process.env.ESBUILD_BINARY_PATH)throw new Error('固定Node22／esbuild环境未满足。');
  const began=performance.now(),check=()=>{if(performance.now()-began>=30000)throw new Error('固定Worker构建软件预算耗尽。');};
  const startedAtMs=Date.now(),req=createRequire(path.join(coreRoot,'package.json'));
  const entryFile=path.join(coreRoot,WORKER_ENTRY),receiptFile=entryFile.replace('.mjs','.build.json');
  // 首次mkdir／receipt之前核实际挂载和批准根；输出集合固定，不接受扩根。
  check();const storage=buildStoragePolicy();check();
  const outputDirectory=path.dirname(entryFile);
  const allowedOutputs=new Set([entryFile,entryFile+'.map',entryFile.replace('.mjs','.meta.json'),receiptFile]);
  storage.check(outputDirectory);check();
  for(const p of allowedOutputs){storage.check(p,{kind:'file'});check();}
  const put=async (p,bytes)=>{
    check();if(!allowedOutputs.has(p))throw new Error('固定Worker输出路径越界。');
    storage.check(outputDirectory,{mustExist:true});storage.check(p,{kind:'file'});check();
    const temp=p+'.new-'+randomUUID();storage.check(temp,{kind:'file'});check();
    await writeFile(temp,bytes,{flag:'wx',mode:0o600});check();
    storage.check(temp,{mustExist:true,kind:'file'});storage.check(p,{kind:'file'});check();
    await rename(temp,p);check();storage.check(p,{mustExist:true,kind:'file'});check();
    const r=await readArtifact(p,check);return{...r.identity,file:path.relative(coreRoot,p)};
  };
  await mkdir(outputDirectory,{recursive:true});check();storage.check(outputDirectory,{mustExist:true});check();
  // 初始失败状态也用新wx临时文件+rename；不截断原receipt、不复用旧闭合声明。
  await put(receiptFile,Buffer.from(JSON.stringify({schema:'mbrs003.metadata-worker.fixed-bundle.v2',status:'BUILD_NOT_CLOSED'})+'\n'));
  const rootInputs=[];
  for(const file of ROOT_INPUTS){const r=await readArtifact(path.resolve(coreRoot,file),check);rootInputs.push({...r.identity,file});}
  const esbuildMain=await realpath(req.resolve('esbuild'));check();
  const toolReq=createRequire(esbuildMain),esbuildPackage=path.resolve(path.dirname(esbuildMain),'../package.json');
  const toolPackage=await readArtifact(esbuildPackage,check);if(JSON.parse(toolPackage.bytes.toString('utf8')).version!=='0.28.2')throw new Error('esbuild版本不匹配。');
  const binPackage='@esbuild/'+process.platform+'-'+process.arch;
  const bin=await realpath(toolReq.resolve(binPackage+'/bin/esbuild'));check();
  const toolInputs=[];for(const p of [esbuildMain,esbuildPackage,bin])toolInputs.push((await readArtifact(p,check)).identity);
  const metadataEntry=await realpath(req.resolve('music-metadata'));check();
  const eofEntry=await realpath(req.resolve('strtok3'));check();
  const metadataDependencyEofEntry=await realpath(createRequire(metadataEntry).resolve('strtok3'));check();
  if(eofEntry!==metadataDependencyEofEntry)throw new Error('EOF依赖身份不一致。');
  const eofClass=path.join(path.dirname(eofEntry),'stream/Errors.js');
  const builtins=new Set(builtinModules.flatMap(x=>[x,x.startsWith('node:')?x:'node:'+x]));
  const loaded=new Map(),packages=new Map();let total=0;
  const capturePackage=async f=>{
    let d=path.dirname(f);
    while(d!==path.dirname(d)){
      check();const p=path.join(d,'package.json');let st;
      try{st=await lstat(p);}catch(e){if(e.code!=='ENOENT')throw e;}check();
      if(st){const cp=await realpath(p);check();if(!packages.has(cp))packages.set(cp,(await readArtifact(cp,check)).identity);return;}d=path.dirname(d);
    }
  };
  const esbuild=await import(pathToFileURL(esbuildMain).href);check();let result;
  const timer=setTimeout(()=>esbuild.stop(),Math.max(1,Math.ceil(30000-(performance.now()-began))));
  try {
    result=await esbuild.build({entryPoints:[path.join(coreRoot,'src/library/metadata-reader-worker.ts')],absWorkingDir:coreRoot,outfile:entryFile,
      bundle:true,write:false,metafile:true,format:'esm',platform:'node',target:'node22',conditions:['node'],splitting:false,
      sourcemap:'external',sourcesContent:true,minify:false,logLevel:'silent',external:[...builtins],
      banner:{js:"import { createRequire as __metadataRequire } from 'node:module'; const require = __metadataRequire(import.meta.url);"},
      plugins:[{name:'fixed-loaded-code',setup(b){b.onLoad({filter:/.*/,namespace:'file'},async args=>{
        check();const p=await realpath(args.path);check();if(!/\.(?:ts|js|mjs|cjs|json)$/.test(p))throw new Error('非代码依赖不准入。');
        const r=await readArtifact(p,check);const previous=loaded.get(p);if(previous&&!same(previous,r.identity))throw new Error('依赖漂移。');
        if(!previous){loaded.set(p,r.identity);total+=r.identity.bytes;}if(loaded.size>2048||total>64*1024*1024)throw new Error('依赖预算超限。');
        await capturePackage(p);const text=r.bytes.toString('utf8');if(!Buffer.from(text).equals(r.bytes))throw new Error('依赖UTF8不可无损。');
        // actual loadedInputs保留原始文件身份；esbuild graph.bytes对应明确的调试注释转换后输入。
        const contents=fixedMetadataBuildSource(text,p);
        return{contents,loader:p.endsWith('.ts')?'ts':p.endsWith('.json')?'json':'js',resolveDir:path.dirname(p)};
      });}}],
    });check();
  } finally {clearTimeout(timer);esbuild.stop();}
  if(result.warnings.length)throw new Error('bundle警告不准入。');
  for(const row of Object.values(result.metafile.outputs))for(const edge of row.imports)if(!edge.external||!builtins.has(edge.path))throw new Error('非builtin外部加载不准入。');
  if(!loaded.has(eofClass)||!loaded.has(eofEntry)||!LOADER_FILES.every(f=>loaded.has(path.join(path.dirname(metadataEntry),f))))throw new Error('EOF或parser loader闭集遗漏。');
  for(const r of [...loaded.values(),...packages.values(),...toolInputs]){const n=await readArtifact(r.file,check);if(!same(r,n.identity))throw new Error('构建输入漂移。');}
  for(const r of rootInputs){const n=await readArtifact(path.resolve(coreRoot,r.file),check);if(!same(r,n.identity))throw new Error('构建根输入漂移。');}
  const outputs=new Map();
  for(const out of result.outputFiles){if(![entryFile,entryFile+'.map'].includes(out.path))throw new Error('bundle产物集合错误。');outputs.set(out.path,await put(out.path,Buffer.from(out.contents)));}
  if(outputs.size!==2)throw new Error('bundle产物不足。');
  const metafile=await put(entryFile.replace('.mjs','.meta.json'),Buffer.from(JSON.stringify(result.metafile,null,2)+'\n'));
  const manifest={schema:'mbrs003.metadata-worker.fixed-bundle.v2',status:'FRESH_FIXED_WORKER_BUNDLE_BUILT',
    entry:outputs.get(entryFile),map:outputs.get(entryFile+'.map'),metafile,rootInputs,
    loadedInputs:[...loaded.values()].sort((a,b)=>a.file.localeCompare(b.file)),packageInputs:[...packages.values()].sort((a,b)=>a.file.localeCompare(b.file)),toolInputs,
    metadataEntry,eofEntry,metadataDependencyEofEntry,eofClass,loaderFiles:LOADER_FILES,builtinExternals:[...builtins].sort(),
    esbuildVersion:'0.28.2',nodeMajor:22,format:'esm',platform:'node',splitting:false,startedAtMs,finishedAtMs:Date.now(),
    readerV1Binding:false,runtimeValidationClaim:false,scalePass:false,whole003Pass:false};
  await put(receiptFile,Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
  await readFixedMetadataWorkerBundle(coreRoot,check);
  return manifest;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  buildFixedMetadataWorkerBundle().then(()=>console.log('固定Metadata Worker bundle构建完成；运行验证另取证。')).catch(()=>{console.error('固定Metadata Worker构建失败，禁止复用旧绑定。');process.exitCode=1;});
}
