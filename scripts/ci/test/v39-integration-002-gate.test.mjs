import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import * as authority from '../v39-integration-002-admission.mjs';
import { captureCiReportMirrorStage } from '../verify-ci-report-mirror.mjs';
import { inspectV39StandardRaw } from '../verify-v39-integration.mjs';
import { buildV39Integration002GateSummary,validateV39Integration002GateArguments,buildV39Integration002FeatureProof,encodeV39ObserverWords513,decodeV39ObserverWords513 } from '../verify-v39-integration-002.mjs';
import { privateRoot,writeFixture,tinyTap,sourceFixture,fixtureEnvironment,toolFixture,fakeArtifact } from './v39-integration-002-admission.test.mjs';
import { artifactBehaviors } from './v39-integration-002-artifacts.test.mjs';
const repository=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../../..');
const role=process.env.V39_INTEGRATION002_GATE_ROLE??'source',skip='EXACT_PARENT_CURRENT_SOURCE_PRODUCT_EVIDENCE_REUSED_NOT_REPEATED';
const loader=pathToFileURL(createRequire(path.join(repository,'packages/bridge-core/package.json')).resolve('tsx/esm')).href;
const originalSharedOwnerCases=Object.freeze([
 '同Owner五源桥：前四个start响应延迟时第五源仍完成完整EOF与摘要，并分别join原流',
 '同Owner五源桥：原来源context已过期或非有限时，不创建Main请求或HTTP资源',
 '同Owner五源桥：撤销作者后只让原operation取消与join，真实流关闭后Owner才能结束',
 'NAME真实桥：原trusted start经Owner受理后才调用同Main配置，完整分块EOF与SHA保留原job正文',
 'NAME真实桥：取消只触达原operation，迟到fetch及reader实际关闭前Join不能声称physicalClosed',
 'NAME真实桥：未配置或无原start不得调用后端，跨Owner与整wire摘要改变拒绝并收口原资源',
 '暖关闭467：封原NAME后Owner仍沿原port读结果与Join，拒新Start且共享Legacy继续原HTTP',
 '暖关闭467：HTTP已真实Join后的作者失权只记语义取消，原Owner还能消费物理关闭回声',
]);

const WORDS = 8193, MIN = -2147483648, MAX = 2147483647, CAP = 32 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function oracleSha(words) {
  const bytes = new Uint8Array(WORDS * 4), view = new DataView(bytes.buffer);
  for (let index = 0; index < WORDS; index++) view.setInt32(index * 4, words[index], true);
  return hash(bytes);
}
const zeroDescriptor = () => ({ encoding: 'i32-rle-v1', wordCount: WORDS, runs: [[WORDS, 0]], sha256: hash(Buffer.alloc(WORDS * 4)) });
const snapshotWords = ordinal => {
  const words = new Int32Array(WORDS);
  words[0] = ordinal; words[1] = ordinal % 2 ? MIN : MAX;
  words[100 + ordinal % 200] = -ordinal;
  words[1000 + ordinal % 400] = ordinal * 31;
  return Array.from(words);
};
const observerWordCodecBehaviors513 = [() => {
  const words = Array.from(new Int32Array(WORDS)), encoded = encodeV39ObserverWords513(words);
  assert.deepEqual(encoded, zeroDescriptor());
  assert.equal(encoded.sha256, oracleSha(words));
  const envelope = { stable: false, words: encoded }, parsed = JSON.parse(JSON.stringify(envelope));
  assert.equal(parsed.stable, false);
  assert.deepEqual(decodeV39ObserverWords513(parsed.words), words);
  assert.deepEqual(Reflect.ownKeys(encoded), ['encoding', 'wordCount', 'runs', 'sha256']);
},
() => {
  const words = Array.from(new Int32Array(WORDS));
  words.fill(MIN, 20, 23); words.fill(MAX, 23, 27); words[27] = -1; words[28] = 1;
  const encoded = encodeV39ObserverWords513(words);
  assert.deepEqual(encoded.runs, [[20, 0], [3, MIN], [4, MAX], [1, -1], [1, 1], [WORDS - 29, 0]]);
  assert.equal(encoded.sha256, oracleSha(words));
  assert.deepEqual(decodeV39ObserverWords513(JSON.parse(JSON.stringify(encoded))), words);
},
() => {
  const words = Array.from({ length: WORDS }, (_, index) => index % 2 ? MAX : MIN), encoded = encodeV39ObserverWords513(words);
  assert.equal(encoded.runs.length, WORDS);
  for (let index = 0; index < WORDS; index++) assert.deepEqual(encoded.runs[index], [1, index % 2 ? MAX : MIN]);
  assert.equal(encoded.sha256, oracleSha(words));
  assert.deepEqual(decodeV39ObserverWords513(encoded), words);
  assert.ok(Buffer.byteLength(JSON.stringify(encoded)) < CAP, 'dense最坏只核本件，不能扩大全部原32MiB cap');
},
() => {
  const zeros = () => Array.from(new Int32Array(WORDS)), valid = zeroDescriptor();
  for (const length of [WORDS - 1, WORDS + 1]) assert.throws(() => encodeV39ObserverWords513(new Array(length).fill(0)));
  const extraWords = zeros(); extraWords.extra = 1;
  const sparseWords = zeros(); delete sparseWords[3];
  const accessorWords = zeros(); Object.defineProperty(accessorWords, '3', { enumerable: true, get() { throw Error('不得读取accessor'); } });
  for (const words of [extraWords, sparseWords, accessorWords]) assert.throws(() => encodeV39ObserverWords513(words));
  for (const value of [NaN, Infinity, 0.5, -0, MIN - 1, MAX + 1, '0']) {
    const words = zeros(); words[3] = value; assert.throws(() => encodeV39ObserverWords513(words));
  }
  const bad = [];
  bad.push({ ...valid, extra: true }, { ...valid, encoding: 'other' }, { ...valid, wordCount: WORDS - 1 }, { ...valid, wordCount: String(WORDS) });
  const hidden = { ...valid }; Object.defineProperty(hidden, 'extra', { value: 1 }); bad.push(hidden);
  const symbol = { ...valid, [Symbol('extra')]: 1 }; bad.push(symbol);
  const inherited = Object.assign(Object.create({ extra: 1 }), valid); bad.push(inherited);
  const sparseRuns = new Array(2); sparseRuns[1] = [WORDS, 0]; bad.push({ ...valid, runs: sparseRuns });
  const sparsePair = new Array(2); sparsePair[0] = WORDS; bad.push({ ...valid, runs: [sparsePair] });
  const extraPair = [WORDS, 0, 0]; bad.push({ ...valid, runs: [extraPair] });
  const extraRuns = [[WORDS, 0]]; extraRuns.extra = 1; bad.push({ ...valid, runs: extraRuns });
  const accessor = { ...valid }; Object.defineProperty(accessor, 'runs', { enumerable: true, get() { throw Error('不得读取accessor'); } }); bad.push(accessor);
  bad.push({ ...valid, runs: [[4096, 0], [4097, 0]] }, { ...valid, runs: [] }, { ...valid, runs: [[WORDS - 1, 0]] },
    { ...valid, runs: [[WORDS + 1, 0]] }, { ...valid, runs: [[WORDS, 0], [1, 1]] }, { ...valid, runs: [[Number.MAX_SAFE_INTEGER, 0]] });
  for (const count of [0, -1, 1.5, Infinity, '8193']) bad.push({ ...valid, runs: [[count, 0]] });
  for (const value of [NaN, Infinity, 0.5, -0, MIN - 1, MAX + 1, '0']) bad.push({ ...valid, runs: [[WORDS, value]] });
  bad.push({ ...valid, sha256: 'z'.repeat(64) }, { ...valid, sha256: valid.sha256.toUpperCase() },
    { ...valid, sha256: (valid.sha256[0] === '0' ? '1' : '0') + valid.sha256.slice(1) });
  for (const descriptor of bad) assert.throws(() => decodeV39ObserverWords513(descriptor));
  const changed = { ...valid, runs: [[WORDS, 1]] }; assert.throws(() => decodeV39ObserverWords513(changed), '有效RLE但不同原字节也必须拒旧SHA');
  assert.deepEqual(decodeV39ObserverWords513(valid), zeros(), '拒绝反例不能改变后续合法decode');
},
() => {
  const snapshots = Array.from({ length: 4000 }, (_, ordinal) => ({ ordinal, stable: ordinal % 5 !== 0,
    words: encodeV39ObserverWords513(snapshotWords(ordinal)) }));
  const bytes = Buffer.from(JSON.stringify(snapshots));
  assert.ok(bytes.length <= CAP, '仍是原32MiB，不抬cap');
  assert.ok(4000 * (WORDS * 2 + 1) > CAP, '即使原dense全零字串，4000整件的独立最小字节下界也超过cap');
  const parsed = JSON.parse(bytes.toString('utf8')); assert.equal(parsed.length, 4000);
  for (let ordinal = 0; ordinal < parsed.length; ordinal++) {
    assert.equal(parsed[ordinal].ordinal, ordinal); assert.equal(parsed[ordinal].stable, ordinal % 5 !== 0);
    const decoded = decodeV39ObserverWords513(parsed[ordinal].words), expected = snapshotWords(ordinal);
    assert.equal(decoded.length, WORDS); assert.equal(parsed[ordinal].words.sha256, oracleSha(expected));
    for (let index = 0; index < WORDS; index++) assert.equal(decoded[index], expected[index], `原快照${ordinal}的word${index}必须完整一致`);
  }
}];

async function physicalObserverConsumerBehavior513() {
  const require = createRequire(import.meta.url), ts = require(path.join(repository, 'node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.js'));
  const source = readFileSync(path.join(repository, 'scripts/ci/verify-v39-integration-002.mjs'), 'utf8'), ast = ts.createSourceFile('gate.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let helpers;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'NORMAL_HELPER513_SOURCES') helpers = node.initializer; ts.forEachChild(node, visit); }
  visit(ast); assert.ok(helpers && ts.isObjectLiteralExpression(helpers));
  const core = helpers.properties.find(node => node.name.text === 'core-evidence513.candidate.ts'); assert.ok(core && ts.isStringLiteral(core.initializer));
  const compiled = ts.transpileModule(core.initializer.text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
  assert.deepEqual(compiled.diagnostics ?? [], []);
  const consumer = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputText).toString('base64'));
  const decode = consumer.decodeObserverPhysicalWords513, words = Array.from(new Int32Array(8193));
  words[1] = MIN; words[2] = MAX; words[3] = -17; words[4] = -1; words[5] = 712; words[6] = -819; words[7] = MIN; words[8] = -2;
  const descriptor = encodeV39ObserverWords513(words);
  assert.deepEqual(decode({ stable: true, words: descriptor }), words);
  for (const value of [null, { stable: false, words: null }, { stable: false, words: descriptor }, { stable: true, words: null }, { stable: true, words: descriptor, extra: true }, { stable: 'true', words: descriptor }]) assert.throws(() => decode(value));
  const accessor = { words: descriptor }; Object.defineProperty(accessor, 'stable', { enumerable: true, get() { throw Error('不得读取accessor'); } }); assert.throws(() => decode(accessor));
  const busy = [...words]; busy[0] = 1; assert.throws(() => decode({ stable: true, words: encodeV39ObserverWords513(busy) }));
  const changed = JSON.parse(JSON.stringify(descriptor)); changed.runs[0][1] = 1; assert.throws(() => decode({ stable: true, words: changed }));
  const directory = privateRoot('observer-codec-consumer'), live = path.join(directory, 'events-' + process.pid + '-1.jsonl');
  const row = state => ({ ordinal: 1, kind: 'FD_OPEN', wallAtMs: Date.now(), monotonicAtMs: 1, value: { nested: { physicalResourceState: state } } });
  for (const state of [null, { stable: false, words: null }, { stable: true, words: descriptor }]) {
    writeFileSync(live, JSON.stringify(row(state)) + '\n', { mode: 0o600 });
    const prefix = await consumer.readLiveCoreEventPrefix513(directory, process.pid); assert.equal(prefix[0].rows.length, 1);
    assert.deepEqual(prefix[0].rows[0].value.nested.physicalResourceState, state);
  }
  for (const state of [{ stable: false, words: descriptor }, { stable: true, words: changed }, { stable: true, words: null }]) {
    writeFileSync(live, JSON.stringify(row(state)) + '\n', { mode: 0o600 });
    await assert.rejects(consumer.readLiveCoreEventPrefix513(directory, process.pid));
  }
  for (const thread of [0, 1]) writeFileSync(path.join(directory, 'actual-' + process.pid + '-' + thread + '.json'), JSON.stringify({ physicalResourceFinal: { stable: true, words: changed } }) + '\n', { mode: 0o600 });
  await assert.rejects(consumer.readClosedCoreEvidence513(directory, process.pid, null, null, null, {}), /原观察器Int32字编码无效/u);
  const apiNode = helpers.properties.find(node => node.name.text === 'normal-api513.candidate.ts'); assert.ok(apiNode && ts.isStringLiteral(apiNode.initializer));
  const dtoUrl = pathToFileURL(path.join(repository, 'packages/contracts/dist/index.js')).href, officialDto = await import(dtoUrl);
  const apiSource = apiNode.initializer.text.replace("from '@music-bridge/contracts'", 'from ' + JSON.stringify(dtoUrl));
  const apiCompiled = ts.transpileModule(apiSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true }); assert.deepEqual(apiCompiled.diagnostics ?? [], []);
  const apiModule = await import('data:text/javascript;base64,' + Buffer.from(apiCompiled.outputText).toString('base64'));
  const apiInput = { datasetId: 'root-owned-synthetic-read-routing513', deadlineAtMs: Date.now() + 30000 }, calls = [];
  const supervisor = { async request(command, payload, datasetId, read) {
    assert.equal(datasetId, apiInput.datasetId);
    if (read) { assert.equal(officialDto.isLibraryReadCommand(command), true); assert.ok(Number.isSafeInteger(read.deadlineAtMs)); assert.ok(read.deadlineAtMs > Date.now() && read.deadlineAtMs <= Date.now() + 2000 && read.deadlineAtMs <= apiInput.deadlineAtMs); assert.equal(read.signal.aborted, false); }
    else assert.equal(officialDto.isLibraryReadCommand(command), false);
    calls.push({ command, read: read !== undefined }); return { scope: 'SYNTHETIC_CALL_ARGUMENTS_ONLY_NOT_OWNER' };
  } };
  const api = apiModule.createNormalApi513(apiInput, {}, supervisor, {}, {}, {});
  for (const command of ['localCatalog.root', 'localScan.start', 'localScan.get', 'localSourceWrites.get', 'localSourceWrites.setPolicy', 'localSourceWrites.preview', 'library.search']) await api.core(command, {});
  assert.equal(calls.length, 7); assert.deepEqual(calls.map(value => value.read), [false, false, false, false, false, false, true]);
}

const run=(index,body)=>test(authority.V39_INTEGRATION_GATE_CASE_NAMES[index],index<3&&role==='report'?{skip}: {},async t=>{await new Promise(resolve=>setImmediate(resolve));await body(t);});
async function realProduct(t,file,{originalSharedOwner=false}={}){const root=privateRoot('current-owner'),deadline=performance.now()+90000;
 const childEnv={...process.env,TMPDIR:root,NODE_ENV:'test',COREPACK_ENABLE_NETWORK:'0'};delete childEnv.NODE_TEST_CONTEXT;
 // 此安全用例保原8个组件行为；完整Main只在后续current-composition的真实构建绑定中执行。
 const pattern='(?:'+originalSharedOwnerCases.join('|')+')$';
 const args=['--import',loader,'--test','--test-reporter=tap',...(originalSharedOwner?['--test-name-pattern='+pattern]:[]),file];
 const raw=await captureCiReportMirrorStage({directory:repository,outputRoot:root,name:'owned-product',args,
  env:childEnv,deadline,expectedTests:originalSharedOwner?originalSharedOwnerCases.length:null,expectedCaseNames:originalSharedOwner?originalSharedOwnerCases:null});
 assert.equal(authority.v39Integration002StagePassed(raw),true);const stdout=readFileSync(path.join(root,'owned-product.stdout.log')),stderr=readFileSync(path.join(root,'owned-product.stderr.log')),
  parsed=authority.parseV39Integration002Tap(stdout);assert.equal(parsed.counts.skipped,0);assert.ok(parsed.counts.pass>0);
 t.diagnostic('V39_002_CURRENT_PRODUCT_RAW='+JSON.stringify({file,stage:raw,stdoutBase64:stdout.toString('base64'),stderrBase64:stderr.toString('base64'),
  evidenceLayer:'SYNTHETIC_CURRENT_CODE_NOT_DEVICE_OR_OWNER'}));}
run(0,async t=>{await realProduct(t,'packages/bridge-core/test/v39/local-workbench-shared-owner.test.ts',{originalSharedOwner:true});});
run(1,async()=>{
 const {createCollectionRepository}=await import('../../../packages/bridge-core/src/collection/repository.ts');
 const {createLocalWorkbenchOwnerPersistence}=await import('../../../packages/bridge-core/src/collection/local-library-workbench/owner-journal.ts');
 const {createBackupWorkflowStore}=await import('../../../packages/bridge-core/src/recording/backup-workflow-store.ts');
 const root=privateRoot('cold-owner'),file=path.join(root,'synthetic.sqlite'),identityFile=path.join(root,'dataset-identity.sqlite');
 const first=createCollectionRepository({filePath:file});let second,firstClosed=false,state=createBackupWorkflowStore({filePath:identityFile});
 try{first.localCatalog.roots();const identity=state.datasetIdentities.bind('default',file,false),dataset=identity.datasetId;
  assert.equal(typeof first.localCatalog.privateWorkbenchSnapshot,'function');assert.equal(typeof first.localCatalog.privateWorkbenchCompareAndSwap,'function');
  const persistence=createLocalWorkbenchOwnerPersistence(dataset,first.localCatalog);await assert.rejects(persistence.load(dataset));
  first.localCatalog.privateBindWorkbenchDataset(identity);assert.equal(await persistence.load(dataset),null);
  const snapshot={schemaVersion:1,datasetId:dataset,revision:1,entries:[]};await persistence.save(snapshot,0);assert.deepEqual(await persistence.load(dataset),snapshot);
  first.close();firstClosed=true;state.close();await assert.rejects(persistence.load(dataset));
  state=createBackupWorkflowStore({filePath:identityFile});second=createCollectionRepository({filePath:file});second.localCatalog.roots();
  const coldIdentity=state.datasetIdentities.bind('default',file,false);assert.equal(coldIdentity.datasetId,dataset);second.localCatalog.privateBindWorkbenchDataset(coldIdentity);
  const cold=createLocalWorkbenchOwnerPersistence(dataset,second.localCatalog);assert.deepEqual(await cold.load(dataset),snapshot);
  await assert.rejects(cold.save(snapshot,0));assert.deepEqual(await cold.load(dataset),snapshot);
 }finally{if(!firstClosed)first.close();second?.close();state.close();}
});
run(2,async()=>{const {createCueNativeActor}=await import('../../../packages/bridge-core/src/library/bundled-cue-converter.ts'),
 {readCueQualifiedFormats}=await import('../../../packages/bridge-core/src/library/local-cue-format-qualification.ts');
 const root=privateRoot('native-failure'),file=path.join(root,'source.wav');writeFileSync(file,'受控原始bytes');const before=readFileSync(file),handle=await open(file,'r');
 try{assert.throws(()=>createCueNativeActor({root,manifestSha256:'0'.repeat(64),files:[]}));assert.throws(()=>readCueQualifiedFormats({formats:Array.from({length:8},()=>({available:true}))}));}
 finally{await handle.close();}await assert.rejects(handle.stat(),error=>error.code==='EBADF');assert.deepEqual(readFileSync(file),before);
 const reopened=await open(file,'r');try{assert.equal((await reopened.readFile()).toString(),'受控原始bytes');}finally{await reopened.close();}
});
run(3,()=>{const raw=Buffer.concat([Buffer.from('fresh-contracts-compiler\nfresh-core-compiler\nfresh-fixed-metadata-worker\nelectron-vite build\nbuilt in\n'),
 ...Array.from({length:4},(_v,i)=>tinyTap(['合成生产段'+i]))]);const good=inspectV39StandardRaw(raw,[0,0]);assert.equal(good.tapRuns.length,4);assert.equal(good.totals.tests,4);
 for(const bytes of [raw.subarray(0,raw.indexOf('TAP version 13')),Buffer.from(raw.toString().replace('ok 1 - 合成生产段1','not ok 1 - 合成生产段1')),
 Buffer.from(raw.toString().replace('1..1','1..2')),Buffer.from(raw.toString().replace('# tests 1','# tests 2'))])assert.throws(()=>inspectV39StandardRaw(bytes,[0,0]));
 assert.throws(()=>inspectV39StandardRaw(raw,[0,1]));assert.throws(()=>inspectV39StandardRaw(raw,[1,0]));});
run(4,()=>{const root=privateRoot('cli-policy'),fresh=path.join(root,'new-root');assert.equal(validateV39Integration002GateArguments(['--output-root',fresh],fixtureEnvironment).outputRoot,fresh);
 for(const args of [['--output-root','/tmp/forbidden-root'],['--output-root',fresh,'--output-root',fresh],['--output-root',fresh,'--standard-verify-log',path.join(root,'log')]])assert.throws(()=>validateV39Integration002GateArguments(args,fixtureEnvironment));
 assert.throws(()=>validateV39Integration002GateArguments(['--output-root',fresh],{...fixtureEnvironment,NODE_OPTIONS:'--require=evil'}));});
run(5,()=>{const f=sourceFixture(),source=authority.inspectV39Integration002Admission(f.directory,fixtureEnvironment);assert.throws(()=>authority.v39Integration002WorkflowOutputs({...source}));
 const summary=toolFixture(f.source).summary;summary.sourceAfter=structuredClone(summary.sourceAfter);summary.sourceAfter.identity.head=authority.V39_INTEGRATION_BASE;assert.notDeepEqual(summary.sourceBefore,summary.sourceAfter);
 assert.throws(()=>buildV39Integration002FeatureProof({matrix:{task:authority.V39_INTEGRATION_TASK,rows:[]},sourceBefore:summary.sourceBefore,role:'source',stages:[]}));});
run(6,async()=>{const root=privateRoot('natural-child'),record=await captureCiReportMirrorStage({directory:repository,outputRoot:root,name:'natural',args:['-e',"process.stdout.write('实际whole stdout\\n');process.stderr.write('实际whole stderr\\n')"],
 env:{...fixtureEnvironment,TMPDIR:root},deadline:performance.now()+5000,expectedTests:null,expectedCaseNames:null});assert.equal(authority.v39Integration002StagePassed(record),true);
 assert.equal(readFileSync(path.join(root,'natural.stdout.log'),'utf8'),'实际whole stdout\n');assert.equal(readFileSync(path.join(root,'natural.stderr.log'),'utf8'),'实际whole stderr\n');});
run(7,async()=>{for(const [name,body]of [['timeout','setInterval(()=>{},1000)'],['overflow','process.stdout.write(Buffer.alloc(17*1024*1024));setInterval(()=>{},1000)'],
 ['detached-pipe',"require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});setTimeout(()=>process.exit(0),50)"]]){
 const root=privateRoot('closed-'+name),record=await captureCiReportMirrorStage({directory:repository,outputRoot:root,name,args:['-e',body],env:{...fixtureEnvironment,TMPDIR:root},
 deadline:performance.now()+7000,timeoutMs:5000,expectedTests:null,expectedCaseNames:null});assert.equal(authority.v39Integration002StagePassed(record),false);assert.equal(record.physicalShutdown.pidAbsent,true);
 assert.equal(record.physicalShutdown.processGroupAbsent,true);assert.equal(record.observedDescendantsAbsent,true);assert.ok(record.timedOut||record.overflow||record.unexpectedPipeHolder);}});
run(8,async()=>{for(const body of artifactBehaviors)await body(); for(const body of observerWordCodecBehaviors513)await body(); await physicalObserverConsumerBehavior513();});
run(9,()=>{const f=sourceFixture(),source=toolFixture(f.source),report=toolFixture(f.source,'report','a'.repeat(40));assert.equal(source.records.length,28);assert.equal(report.records.length,22);
 const decoded=authority.decodeV39Integration002ToolContent(report.toolContent);assert.equal(decoded.summary.productVerificationRepeated,false);assert.equal(decoded.summary.productEvidenceReuse,'EXACT_PARENT_CURRENT_SOURCE_EVIDENCE');
 assert.equal(decoded.summary.stages.find(row=>row.name==='gate-safety').testCounts.skipped,3);assert.equal(decoded.summary.ownerAcceptance,'NOT_RUN');
 const artifact=fakeArtifact(report.records,{id:1001,name:'verify-'+decoded.summary.head,profile:'verify-report',source:f.source,head:decoded.summary.head,toolContent:report.toolContent});
 assert.equal(authority.validateV39Integration002ReportToolContent(artifact,f.source,decoded.summary.head),true);});
