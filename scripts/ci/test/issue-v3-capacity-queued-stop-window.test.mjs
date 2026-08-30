import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const sourceIssuer = new URL('../issue-v3-capacity-queued-stop-window.py', import.meta.url).pathname
const python = realpathSync('/opt/homebrew/bin/python3')
const put = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim()
function rootIdentity(path, marker) { const s=lstatSync(path); return {path,device:s.dev,inode:s.ino,marker:{relative:marker,sha256:sha(join(path,marker))}} }

function candidate(root) {
  const base=['package.json','pnpm-lock.yaml','packages/bridge-core/package.json','packages/contracts/package.json','packages/bridge-core/test/benchmarks/recording-capacity.ts','packages/bridge-core/test/benchmarks/recording-capacity-process.ts']
  for (const relative of base) { const path=join(root,relative); mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,`${relative}\n`) }
  for(let i=1;i<=235;i++){const path=join(root,'packages/bridge-core/src',`source-${String(i).padStart(3,'0')}.ts`);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,`export const v${i}=${i}\n`)}
  for(const dir of ['packages/bridge-core/test/helpers','packages/contracts/src','packages/contracts/dist']) mkdirSync(join(root,dir),{recursive:true})
  const issuer=join(root,'scripts/ci/issue-v3-capacity-queued-stop-window.py'), supervisor=join(root,'scripts/ci/capacity-phase-supervisor-v2.py')
  mkdirSync(dirname(issuer),{recursive:true});cpSync(sourceIssuer,issuer);chmodSync(issuer,0o700);writeFileSync(supervisor,'#!/usr/bin/env python3\nraise SystemExit(99)\n');chmodSync(supervisor,0o700)
  execFileSync('/usr/bin/git',['init','-b','main'],{cwd:root});git(root,'config','user.email','test@example.invalid');git(root,'config','user.name','Test');git(root,'add','.');git(root,'commit','-m','fixture')
  return {issuer,supervisor,head:git(root,'rev-parse','HEAD')}
}

function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'queued-issuer-test-'))),runtime=join(root,'runtime');mkdirSync(runtime);const c=candidate(root)
  const tools=join(root,'tools');mkdirSync(tools);const node=join(tools,'node'),tsx=join(tools,'loader.mjs');writeFileSync(node,'#!/bin/sh\nexit 97\n');chmodSync(node,0o700);writeFileSync(tsx,'export {}\n')
  const seedLabel='objects-seed',seed=join(runtime,seedLabel),fixtureDirectory=join(root,'musicbridge-version-fixture');mkdirSync(seed);mkdirSync(fixtureDirectory)
  put(join(fixtureDirectory,'capacity-owner.json'),{id:randomUUID(),scope:'musicbridge-capacity-synthetic-only'});writeFileSync(join(seed,'seed.sqlite'),'synthetic snapshot');const snapshotSha=sha(join(seed,'seed.sqlite'))
  put(join(seed,'seed.json'),{schema:21,profile:'objects-limit',integrity:'passed',growth:{state:'target-reached'},snapshotSha256:snapshotSha,fixtureDirectory,deviceOpened:false,formalReady:false,gateB:'NOT_RUN'})
  const measureId=randomUUID(),measureLabel='objects-measure-pass',measure=join(runtime,'objects-measure-window');mkdirSync(join(measure,'issuer-identity'),{recursive:true});mkdirSync(join(measure,'supervision'))
  put(join(measure,'owner.json'),{scope:'musicbridge-capacity-measure-window',owner:'root',id:measureId});put(join(measure,'issuer-identity/owner.json'),{scope:'test',id:randomUUID()})
  const measureSupervisor=join(measure,'supervisor.py');writeFileSync(measureSupervisor,'frozen supervisor\n')
  const measureOutput=join(runtime,measureLabel);mkdirSync(measureOutput);put(join(measureOutput,'command.json'),{phase:'measure',profile:'objects-limit',window:measureId,deviceOpened:false,formalReady:false,gateB:'NOT_RUN'})
  const source=join(measure,'source-pins.json');put(source,{schemaVersion:1,scope:'musicbridge-capacity-source-pins',files:{frozen:'a'.repeat(64)}})
  const roots=[rootIdentity(measure,'owner.json'),rootIdentity(seed,'seed.json'),rootIdentity(fixtureDirectory,'capacity-owner.json')]
  for(let i=1;i<=67;i++){const path=join(runtime,`retained-${String(i).padStart(2,'0')}`);mkdirSync(path);put(join(path,'owner.json'),{id:randomUUID()});roots.push(rootIdentity(path,'owner.json'))} assert.equal(roots.length,70)
  const owned=join(measure,'owned-roots.json');put(owned,{schemaVersion:1,scope:'musicbridge-capacity-owned-roots',access:'count-only',windowId:measureId,roots,futureRoots:[measureOutput]})
  const seedHashes={metadataSha256:sha(join(seed,'seed.json')),snapshotSha256:snapshotSha,fixtureOwnerSha256:sha(join(fixtureDirectory,'capacity-owner.json'))}
  const window=join(measure,'window.json');put(window,{schemaVersion:1,scope:'musicbridge-capacity-measure-window',owner:'root',id:measureId,state:'approved',phase:'measure',profile:'objects-limit',label:measureLabel,seedLabel,n:105,ownedManifest:{file:'owned-roots.json',sha256:sha(owned)},sourceManifest:{file:'source-pins.json',sha256:sha(source)},seed:seedHashes,supervisor:{path:measureSupervisor,sha256:sha(measureSupervisor)}})
  const measurement={verifiedComplete:true,verifiedPassed:true,thresholdPassed:true,authorityStable:true,sampleCount:1575,receiptCount:3,roundReceiptCount:105,stageCount:18,aggregateBudgetValid:true}
  const supervision=join(measure,'supervision/supervisor.json');put(supervision,{passed:true,failure:null,code:0,groupEmpty:true,zombies:[],measurement})
  const close=join(measure,'close.json');put(close,{schemaVersion:1,scope:'musicbridge-capacity-measure-window-close',windowId:measureId,windowSha256:sha(window),state:'passed',failure:null,profile:'objects-limit',label:measureLabel,seedLabel,seed:seedHashes,ownedManifestSha256:sha(owned),sourceManifestSha256:sha(source),supervisorSha256:sha(measureSupervisor),groupEmpty:true,zombies:[],deviceOpened:false,formalReady:false,gateB:'NOT_RUN',replayPolicy:'terminal-window-id-and-label-never-reuse',measurement})
  return {root,runtime,...c,node,tsx,seedLabel,seed,fixtureDirectory,measureId,measureLabel,measure,window,close,owned,source,supervision,measureSupervisor,measureOutput,seedHashes}
}

function args(f){return [f.issuer,'--repo-root',f.root,'--runtime-root',f.runtime,'--measure-window',f.window,'--expected-measure-window-id',f.measureId,'--expected-measure-window-sha256',sha(f.window),'--measure-close',f.close,'--expected-measure-close-sha256',sha(f.close),'--measure-owned-manifest',f.owned,'--expected-measure-owned-sha256',sha(f.owned),'--measure-source-manifest',f.source,'--expected-measure-source-sha256',sha(f.source),'--measure-supervision',f.supervision,'--expected-measure-supervision-sha256',sha(f.supervision),'--measure-supervisor',f.measureSupervisor,'--expected-measure-supervisor-sha256',sha(f.measureSupervisor),'--expected-measure-close-supervisor-sha256',sha(f.measureSupervisor),'--measure-output',f.measureOutput,'--expected-measure-label',f.measureLabel,'--expected-measure-output-command-sha256',sha(join(f.measureOutput,'command.json')),'--seed-label',f.seedLabel,'--expected-seed-metadata-sha256',f.seedHashes.metadataSha256,'--expected-seed-snapshot-sha256',f.seedHashes.snapshotSha256,'--expected-seed-fixture-owner-sha256',f.seedHashes.fixtureOwnerSha256,'--window-dir-name','objects-queued-window','--label','objects-queued-run','--profile','objects-limit','--expected-branch','main','--expected-head',f.head,'--supervisor',f.supervisor,'--expected-supervisor-sha256',sha(f.supervisor),'--node',f.node,'--expected-node-sha256',sha(f.node),'--tsx-loader',f.tsx,'--expected-tsx-loader-sha256',sha(f.tsx),'--consumer-python',python,'--expected-consumer-sha256',sha(python),'--issuer-repo-root',f.root,'--expected-issuer-branch','main','--expected-issuer-head',f.head,'--expected-issuer-sha256',sha(f.issuer)]}
const run=f=>spawnSync(python,args(f),{encoding:'utf8'}), cleanup=f=>rmSync(f.root,{recursive:true,force:true})
function options(f){const value={};const values=args(f);for(let i=1;i<values.length;i+=2)value[values[i].slice(2).replaceAll('-','_')]=values[i+1];return value}
function pythonCall(body,...values){const bridge=`import importlib.util,json,sys,types\ns=importlib.util.spec_from_file_location('issuer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n${body}`;return spawnSync(python,['-c',bridge,sourceIssuer,...values],{encoding:'utf8'})}

test('queued-stop issuer生产入口存在且拒绝空参数',()=>{assert.equal(existsSync(sourceIssuer),true);const r=spawnSync(python,[sourceIssuer],{encoding:'utf8'});assert.equal(r.status,2);assert.match(r.stderr,/required/u)})
test('自洽synthetic measure也必须被生产冻结window06身份拒绝',()=>{const f=fixture();try{const r=run(f);assert.equal(r.status,1);assert.match(r.stderr,/FROZEN_MEASURE/u);assert.equal(existsSync(join(f.runtime,'objects-queued-window')),false)}finally{cleanup(f)}})
test('纯payload构造冻结toolchain与issuer事实且不提供发行override',()=>{const h='a'.repeat(64),kwargs={window_id:randomUUID(),label:'objects-queued-run',seed_label:'objects-seed',seed:{label:'objects-seed',metadataSha256:h,snapshotSha256:h,fixtureOwnerSha256:h},issued_at:'2026-08-30T00:00:00.000+00:00',deadline_at:'2026-08-30T00:15:00.000+00:00',owned_sha:h,source_sha:h,plan:{warmupCount:5,formalCount:100,sampleCount:105,activeCloneMaximum:1,snapshotBytes:1990471680,evidenceAllowanceBytes:268435456,plannedBytes:2258907136,model:'serial-single-clone-plus-bounded-growth-v1',aggregateAudit:'queued-stop-aggregate-budget.jsonl'},installed_supervisor:'/authority/supervisor.py',supervisor_sha:h,candidate_root:'/candidate',candidate_branch:'main',candidate_head:'b'.repeat(40),measure_facts:{},node:'/tool/node',node_sha:h,tsx:'/tool/loader.mjs',tsx_sha:h,consumer:'/tool/python',consumer_sha:h,issuer_path:'/candidate/scripts/ci/issue-v3-capacity-queued-stop-window.py',issuer_sha:h,issuer_fact_path:'/authority/issuer-identity/owner.json',issuer_fact_sha:h};const r=pythonCall("print(json.dumps(m.build_window_payload(**json.loads(sys.argv[2]))))",JSON.stringify(kwargs));assert.equal(r.status,0,r.stderr);const window=JSON.parse(r.stdout);assert.deepEqual(window.toolchain,{node:{path:kwargs.node,sha256:h},tsxLoader:{path:kwargs.tsx,sha256:h},consumerPython:{path:kwargs.consumer,sha256:h}});assert.deepEqual(window.issuer,{path:kwargs.issuer_path,sha256:h,fact:{path:kwargs.issuer_fact_path,sha256:h}});assert.equal(window.queuedStopPlan.plannedBytes,2258907136)})
test('纯validator仍拒绝measure非精确PASS',()=>{const f=fixture();try{const close=JSON.parse(readFileSync(f.close));close.measurement.thresholdPassed=false;put(f.close,close);const o=options(f);o.expected_measure_close_sha256=sha(f.close);const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));\ntry:m.validate_measure(o,m.Path(sys.argv[3]))\nexcept m.IssueError as e:print(e);raise SystemExit(1)",JSON.stringify(o),f.runtime);assert.equal(r.status,1);assert.match(r.stdout,/MEASURE_PASS/u)}finally{cleanup(f)}})
test('纯source validator拒绝候选漂移',()=>{const f=fixture();try{writeFileSync(join(f.root,'packages/bridge-core/src/source-001.ts'),'drift\n');const r=pythonCall("\ntry:m.source_manifest(m.Path(sys.argv[2]),sys.argv[3])\nexcept m.IssueError as e:print(e);raise SystemExit(1)",f.root,f.head);assert.equal(r.status,1);assert.match(r.stdout,/SOURCE_CANDIDATE/u)}finally{cleanup(f)}})
