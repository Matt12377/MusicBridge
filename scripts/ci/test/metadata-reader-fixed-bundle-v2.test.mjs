import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { ROOT_INPUTS,LOADER_FILES,WORKER_ENTRY,validateFixedWorkerReceiptShape } from '../../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs';
import { makeReaderBundleBinding } from '../verify-mbrs003-scan.mjs';
const identity=file=>({file,bytes:1,sha256:'a'.repeat(64)});
function fixture(){
  const base='/synthetic/node_modules/music-metadata/lib';const eof='/synthetic/node_modules/strtok3/lib/index.js';
  return{schema:'mbrs003.metadata-worker.fixed-bundle.v2',status:'FRESH_FIXED_WORKER_BUNDLE_BUILT',entry:identity(WORKER_ENTRY),map:identity(WORKER_ENTRY+'.map'),metafile:identity('dist/library/metadata-reader-worker.bundle.meta.json'),
    esbuildVersion:'0.28.2',nodeMajor:22,format:'esm',platform:'node',splitting:false,builtinExternals:['node:fs'],startedAtMs:1,finishedAtMs:2,
    rootInputs:ROOT_INPUTS.map(identity),loadedInputs:[identity('/synthetic/node_modules/strtok3/lib/stream/Errors.js'),...LOADER_FILES.map(f=>identity(path.join(base,f)))],
    packageInputs:[identity('/synthetic/package.json')],toolInputs:['a.js','package.json','bin/esbuild'].map(identity),metadataEntry:base+'/index.js',eofEntry:eof,metadataDependencyEofEntry:eof,
    eofClass:'/synthetic/node_modules/strtok3/lib/stream/Errors.js',loaderFiles:[...LOADER_FILES],readerV1Binding:false,runtimeValidationClaim:false,scalePass:false,whole003Pass:false};
}
test('固定v2仅接完整声明，不把构建当运行或规模PASS',()=>{const v=fixture();assert.equal(validateFixedWorkerReceiptShape(v),v);});
test('旧v1声明在固定bundle接线中拒收',()=>{const v=fixture();v.schema='mbrs003.reader.fresh-build.v1';assert.throws(()=>validateFixedWorkerReceiptShape(v));assert.throws(()=>makeReaderBundleBinding([],{},v));});
test('builder／adapter／package／lock任一漏绑均拒收',()=>{for(const file of ROOT_INPUTS){const v=fixture();v.rootInputs=v.rootInputs.filter(x=>x.file!==file);assert.throws(()=>validateFixedWorkerReceiptShape(v));}});
test('另一EOF依赖或重复EOF类不能声明同身份',()=>{for(const alter of [v=>v.metadataDependencyEofEntry+='.other',v=>v.loadedInputs.push(identity(v.eofClass))]){const v=fixture();alter(v);assert.throws(()=>validateFixedWorkerReceiptShape(v));}});
test('13个lazy parser Loader缺一拒收，不裁剪支持矩阵',()=>{for(const loader of LOADER_FILES){const v=fixture();v.loadedInputs=v.loadedInputs.filter(x=>!x.file.endsWith(loader));assert.throws(()=>validateFixedWorkerReceiptShape(v));}});
test('非固定entry／split／非Node22／自造runtime或scalePASS均拒收',()=>{for(const alter of [v=>v.entry.file='dist/library/user-worker.mjs',v=>v.splitting=true,v=>v.nodeMajor=24,v=>v.runtimeValidationClaim=true,v=>v.scalePass=true,v=>v.builtinExternals.push('unknown-package')]){const v=fixture();alter(v);assert.throws(()=>validateFixedWorkerReceiptShape(v));}});
