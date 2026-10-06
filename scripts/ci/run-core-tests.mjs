import { readdirSync, readFileSync, lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateOfflineArguments, createPrivateRun, writePrivateJson } from './verify-mbrs001-offline.mjs';
import { makeReaderBundleBinding } from './verify-mbrs003-scan.mjs';
import { ROOT_INPUTS, readFixedMetadataWorkerBundle } from '../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/bridge-core');
const isolated = 'recording-capacity-queued-stop.test.ts';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function budget() {
  const started = performance.now();
  const remaining = () => 360_000 - (performance.now() - started);
  const check = () => { if (remaining() <= 0) throw new Error('Core 编译准备总预算360秒耗尽。'); };
  return { check, timeout: () => { check(); return Math.max(1, Math.floor(Math.min(180_000, remaining()))); } };
}
// 准备时钟只约束编译链；封存后继续核身份，但不拿旧准备预算限制完整回归。
export function createPreparationClock(clock) {
  let finished=false;
  return {
    check:()=>{if(!finished)clock.check();},
    timeout:()=>{if(finished)throw new Error('准备已封存，不能重新派发构建。');return clock.timeout();},
    finish:()=>{clock.check();finished=true;},
  };
}
function identity(relative, check) {
  check(); const filename = path.join(repository, relative), info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(filename) !== filename) throw new Error('Core 编译输入/输出必须为真实普通文件。');
  const bytes = readFileSync(filename); check();
  return { path: relative, bytes: bytes.length, sha256: digest(bytes) };
}
// 不依赖Git ignore：全部产品及测试源、编译配置和固定Worker根输入在编译前冻结。
export function coreTestSourceInputs(check = () => {}) {
  const names = new Set();
  const walk = relative => {
    check(); const info = lstatSync(path.join(repository, relative));
    if (info.isSymbolicLink()) throw new Error('Core 输入清单不能沿符号链。');
    if (info.isDirectory()) for (const name of readdirSync(path.join(repository, relative)).sort()) walk(`${relative}/${name}`);
    else if (info.isFile()) names.add(relative);
  };
  for (const directory of ['packages/contracts/src','packages/contracts/test','packages/bridge-core/src','packages/bridge-core/test','apps/desktop/src','apps/desktop/test','apps/desktop/e2e']) walk(directory);
  for (const name of [...ROOT_INPUTS.map(file => path.relative(repository, path.resolve(core, file))),
    'package.json','pnpm-workspace.yaml','scripts/ci/run-core-tests.mjs','scripts/ci/test/run-core-tests.test.mjs',
    'scripts/ci/verify-mbrs001-offline.mjs','scripts/ci/verify-mbrs003-scan.mjs','apps/desktop/scripts/build-storage-root.d.mts',
    ...['packages/contracts','packages/bridge-core','apps/desktop'].flatMap(pkg => [`${pkg}/package.json`,`${pkg}/tsconfig.json`,...(pkg==='apps/desktop'?[]:[`${pkg}/tsconfig.test.json`])])]) names.add(name);
  const extendsConfig = (relative, seen = new Set()) => {
    check(); if (seen.has(relative)) throw new Error('Core tsconfig extends循环。'); seen.add(relative);names.add(relative);
    const config = JSON.parse(readFileSync(path.join(repository,relative),'utf8'));
    if (config.compilerOptions?.incremental || config.compilerOptions?.composite) throw new Error('Core fresh编译不接受增量缓存。');
    if (config.extends !== undefined) {
      if (typeof config.extends !== 'string' || !config.extends.startsWith('.')) throw new Error('Core tsconfig extends未闭合。');
      let target = path.resolve(repository,path.dirname(relative),config.extends); if (!target.endsWith('.json')) target += '.json';
      const next = path.relative(repository,target);if (next.startsWith('..') || path.isAbsolute(next)) throw new Error('Core tsconfig extends越界。');
      extendsConfig(next,seen);
    }
  };
  for (const name of ['packages/contracts/tsconfig.json','packages/bridge-core/tsconfig.json']) extendsConfig(name);
  return [...names].sort().map(name => identity(name,check));
}

/** 每次标准入口均自行准备；外部声明不能替代本次compiler及fixedWorker。 */
export async function prepareCoreTestEnvironment({ env = process.env, execute = spawnSync, announce = console.log, clock = budget() } = {}) {
  clock=createPreparationClock(clock);
  if (process.versions.node.split('.')[0] !== '22') throw new Error('Core fresh Reader准备要求Node22。');
  clock.check();
  const outputRoot = path.join(env.TMPDIR ?? '', `musicbridge-core-reader-${randomUUID()}`);
  const admission = validateOfflineArguments([`--output-root=${outputRoot}`],env);
  const run = createPrivateRun(admission), temporary = path.join(run,'tmp');mkdirSync(temporary,{mode:0o700});
  const childEnv = { ...env, TMPDIR:temporary, NODE_ENV:'test', COREPACK_ENABLE_NETWORK:'0', npm_config_ignore_scripts:'true',
    MBRS003_READER_BUILD_BINDING:path.join(run,'reader-build-binding.json') };
  const sourceInputs = coreTestSourceInputs(clock.check), outputs = [], stages = [];
  const unchanged = () => { if (JSON.stringify(coreTestSourceInputs(clock.check)) !== JSON.stringify(sourceInputs)) throw new Error('Core 编译前冻结输入漂移。'); };
  const require = createRequire(path.join(core,'package.json')), tsc = require.resolve('typescript/bin/tsc');
  const toolFiles=[tsc,require.resolve('typescript/package.json'),...['tsc.js','_tsc.js'].map(name=>path.join(path.dirname(require.resolve('typescript/package.json')),'lib',name))].map(file=>realpathSync(file));
  const toolIdentity=file=>{clock.check();const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||realpathSync(file)!==file)throw new Error('Core compiler工具身份无效。');const bytes=readFileSync(file);clock.check();return {file,bytes:bytes.length,sha256:digest(bytes)};};
  const toolInputs=toolFiles.map(toolIdentity),toolsUnchanged=()=>{if(JSON.stringify(toolFiles.map(toolIdentity))!==JSON.stringify(toolInputs))throw new Error('Core compiler工具漂移。');};
  if (JSON.parse(readFileSync(require.resolve('typescript/package.json'),'utf8')).version !== '5.9.3') throw new Error('Core 固定TypeScript版本不匹配。');
  writePrivateJson(run,'precompile-inputs.json',{schema:'core-test.precompile-inputs.v1',sourceInputs,toolInputs});
  let freshCore;
  for (const stage of [
    {name:'fresh-contracts-compiler',directory:'packages/contracts',args:[tsc,'-p','tsconfig.json']},
    {name:'fresh-core-compiler',directory:'packages/bridge-core',args:[tsc,'-p','tsconfig.json']},
    {name:'fresh-fixed-metadata-worker',directory:'packages/bridge-core',args:['scripts/build-metadata-reader-worker.mjs']},
  ]) {
    clock.check(); unchanged(); toolsUnchanged(); admission.storage.check(temporary,{mustExist:true});
    admission.storage.check(path.join(repository,stage.directory,'dist'));
    const sources = sourceInputs.filter(row=>row.path.startsWith(`${stage.directory}/src/`) && row.path.endsWith('.ts') && !row.path.endsWith('.d.ts'));
    if (!sources.length) throw new Error('Core 编译源清单为空。');
    if (stage.name !== 'fresh-fixed-metadata-worker') for (const source of sources) for (const suffix of ['.js','.js.map','.d.ts']) admission.storage.check(path.join(repository,source.path.replace('/src/','/dist/').slice(0,-3)+suffix),{kind:'file'});
    announce(`Core Reader准备阶段：${stage.name}`);const startedMs=Date.now();
    const result = execute(process.execPath,stage.args,{cwd:path.join(repository,stage.directory),env:childEnv,stdio:'inherit',timeout:clock.timeout(),killSignal:'SIGKILL'});
    if (result.error || result.signal || result.status !== 0) throw new Error('Core fresh准备子进程失败或未自然退出，禁止进入测试。');
    clock.check(); unchanged(); toolsUnchanged();
    const stageOutputs=[];
    if (stage.name !== 'fresh-fixed-metadata-worker') {
      for (const source of sources) for (const suffix of ['.js','.js.map','.d.ts']) {
        const relative=source.path.replace('/src/','/dist/').slice(0,-3)+suffix,row=identity(relative,clock.check),info=lstatSync(path.join(repository,relative));
        stageOutputs.push({...row,sourcePath:source.path,sourceSha256:source.sha256,mtimeMs:info.mtimeMs});
      }
      const finishedMs=Date.now();
      if (stageOutputs.some(row=>row.mtimeMs<startedMs || row.mtimeMs>finishedMs)) throw new Error('Core compiler产物不属于本次实际编译区间。');
      if (stage.name === 'fresh-core-compiler') freshCore={compilerExit:0,compilerStartedAtMs:startedMs,compilerFinishedAtMs:finishedMs,outputs:stageOutputs};
    } else {
      const fixed=await readFixedMetadataWorkerBundle(core,clock.check);
      if (fixed.manifest.startedAtMs<startedMs || fixed.manifest.finishedAtMs>Date.now()) throw new Error('Core 固定Worker不是本次构建。');
      for (const suffix of ['.mjs','.mjs.map','.meta.json','.build.json']) {
        const relative=`packages/bridge-core/dist/library/metadata-reader-worker.bundle${suffix}`,row=identity(relative,clock.check),info=lstatSync(path.join(repository,relative));
        if (info.mtimeMs<startedMs || info.mtimeMs>Date.now()) throw new Error('Core 固定Worker产物时间无效。');stageOutputs.push({...row,mtimeMs:info.mtimeMs});
      }
      unchanged();writePrivateJson(run,'reader-build-binding.json',makeReaderBundleBinding(sourceInputs,freshCore,fixed.manifest));
    }
    outputs.push(...stageOutputs);stages.push({name:stage.name,compilerExit:0,startedMs,finishedMs:Date.now()});
  }
  const declarationBytes=readFileSync(childEnv.MBRS003_READER_BUILD_BINDING), declarationSha=digest(declarationBytes);
  const assertCurrent=()=>{
    clock.check(); unchanged(); toolsUnchanged();
    for (const row of outputs) { const current=identity(row.path,clock.check);if(current.bytes!==row.bytes || current.sha256!==row.sha256 || lstatSync(path.join(repository,row.path)).mtimeMs!==row.mtimeMs)throw new Error('Core fresh产物漂移。'); }
    admission.storage.check(childEnv.MBRS003_READER_BUILD_BINDING,{mustExist:true,kind:'file'});
    if(digest(readFileSync(childEnv.MBRS003_READER_BUILD_BINDING))!==declarationSha)throw new Error('Core 私有Reader声明漂移。');
  };
  assertCurrent();
  const receipt={schema:'core-test.reader-preparation.v1',status:'FRESH_READER_PREPARED',sourceInputs,toolInputs,outputs,stages,readerBindingSha256:declarationSha,inputsUnchanged:true,outputsUnchanged:true};
  writePrivateJson(run,'preparation-receipt.json',receipt);clock.finish();
  return {env:childEnv,privateRoot:run,receipt,assertCurrent};
}

// 保留原 test/*.test.ts 清单，只将依赖墙钟阈值的排队 Stop 放在独立阶段。
export function coreTestPhases(names) {
  const tests = names.filter(name => !name.startsWith('.') && name.endsWith('.test.ts')).sort();
  if (!tests.includes(isolated) || new Set(tests).size !== tests.length || tests.length < 2
    || tests.some(name => name.includes('/') || name.includes('\\'))) {
    throw new Error('Core 测试清单不完整，不能跳过排队 Stop 阶段。');
  }
  const args = ['--import', 'tsx', '--test', '--test-reporter=tap'];
  return [
    { name: '原有 Core 测试', args: [...args, ...tests.filter(name => name !== isolated).map(name => `test/${name}`)] },
    { name: '排队 Stop 独立阶段', args: [...args, '--test-concurrency=1', `test/${isolated}`] },
  ];
}

export function runCoreTestPhases(phases, execute = spawnSync, announce = console.log, { env = process.env, assertCurrent = () => {} } = {}) {
  for (const phase of phases) {
    assertCurrent(); announce(`Core 测试阶段：${phase.name}`);
    const result = execute(process.execPath, phase.args, { cwd: core, env, stdio: 'inherit' });
    if (result.error || result.signal || !Number.isInteger(result.status)) return 1;
    if (result.status !== 0) return result.status;
    assertCurrent();
  }
  return 0;
}

// 准备失败/缺声明/输入漂移在任何测试派发前收口，两个原阶段共享同一私有env。
export async function runPreparedCoreTests(names, { prepare = prepareCoreTestEnvironment, execute = spawnSync, announce = console.log, env = process.env } = {}) {
  const phases=coreTestPhases(names),clock=budget();
  const prepared=await prepare({env,execute,announce,clock});
  if (!prepared || !path.isAbsolute(prepared.env?.MBRS003_READER_BUILD_BINDING ?? '') || typeof prepared.assertCurrent !== 'function') throw new Error('Core fresh Reader准备未完成，禁止派发测试。');
  prepared.assertCurrent();
  return runCoreTestPhases(phases,execute,announce,{env:prepared.env,assertCurrent:prepared.assertCurrent});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPreparedCoreTests(readdirSync(path.join(core,'test'))).then(code=>{process.exitCode=code;}).catch(()=>{
    console.error('Core Reader准备、冻结身份或测试阶段执行失败。');process.exitCode=1;
  });
}
