import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const sourceIssuer = new URL('../issue-v3-capacity-queued-stop-window.py', import.meta.url).pathname
const sourceRecoveryCreator = new URL('../create-v3-capacity-measure-root-recovery.py', import.meta.url).pathname
const sourcePrechildTerminalizer = new URL('../terminalize-v3-capacity-queued-stop-prechild.py', import.meta.url).pathname
const python = realpathSync('/opt/homebrew/bin/python3')
const put = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim()
function rootIdentity(path, marker) { const s=lstatSync(path); return {path,device:s.dev,inode:s.ino,marker:{relative:marker,sha256:sha(join(path,marker))}} }

function prechildTerminalFixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'queued-prechild-terminal-'))),repo=join(root,'recovery'),runtime=join(root,'runtime')
  const authority=join(runtime,'objects-queued-window-02'),issuerIdentity=join(authority,'issuer-identity')
  mkdirSync(issuerIdentity,{recursive:true});mkdirSync(repo)
  const installedSupervisor=join(authority,'supervisor.py')
  writeFileSync(installedSupervisor,`from pathlib import Path\nimport json\ndef _read_json(path):\n try:return json.loads(Path(path).read_text())\n except (OSError,json.JSONDecodeError):return None\ndef _reject_queued_stop_replay(runtime,parent,window):\n for candidate in Path(runtime).iterdir():\n  if candidate == Path(parent):continue\n  paths=[candidate/'window.json',candidate/'close.json',candidate/'issuer-failure.json'] if candidate.is_dir() else ([candidate] if candidate.name.endswith('-close.json') else [])\n  for path in paths:\n   value=_read_json(path)\n   if not isinstance(value,dict):continue\n   {value.get('id'),value.get('windowId'),value.get('label'),value.get('window'),value.get('windowDirName')}\n return True\n`)
  const owner=join(authority,'owner.json'),source=join(authority,'source-pins.json'),owned=join(authority,'owned-roots.json')
  const issuerFact=join(issuerIdentity,'owner.json'),windowPath=join(authority,'window.json')
  const windowId=randomUUID(),label='objects-queued-run-02'
  put(owner,{scope:'musicbridge-capacity-queued-stop-window',owner:'root',id:windowId})
  put(source,{schemaVersion:1,scope:'musicbridge-capacity-source-pins',files:{}})
  put(owned,{schemaVersion:1,scope:'musicbridge-capacity-owned-roots',access:'count-only',windowId,roots:[]})
  execFileSync('/usr/bin/git',['init','-b','main'],{cwd:repo});git(repo,'config','user.email','test@example.invalid');git(repo,'config','user.name','Test')
  mkdirSync(join(repo,'scripts/ci'),{recursive:true});cpSync(installedSupervisor,join(repo,'scripts/ci/capacity-phase-supervisor-v2.py'))
  git(repo,'add','.');git(repo,'commit','-m','incident candidate');const candidateHead=git(repo,'rev-parse','HEAD')
  put(issuerFact,{schemaVersion:1,scope:'musicbridge-capacity-queued-stop-authority-issuer',windowId,
    candidateRepository:{root:repo,branch:'main',head:candidateHead}})
  put(windowPath,{schemaVersion:1,scope:'musicbridge-capacity-queued-stop-window',owner:'root',id:windowId,
    state:'approved',phase:'queued-stop',profile:'objects-limit',label,
    candidateRepository:{root:repo,branch:'main',head:candidateHead},
    supervisor:{path:installedSupervisor,sha256:sha(installedSupervisor)},
    ownedManifest:{file:'owned-roots.json',sha256:sha(owned)},sourceManifest:{file:'source-pins.json',sha256:sha(source)}})
  const trigger=join(runtime,'objects-generation-window-01-close.json')
  put(trigger,{schemaVersion:1,scope:'musicbridge-capacity-generation-close',window:{id:randomUUID(),label:'objects-seed-01'}})
  cpSync(sourcePrechildTerminalizer,join(repo,'scripts/ci/terminalize-v3-capacity-queued-stop-prechild.py'))
  git(repo,'add','.');git(repo,'commit','-m','add terminalizer');const recoveryHead=git(repo,'rev-parse','HEAD')
  const terminalizer=join(repo,'scripts/ci/terminalize-v3-capacity-queued-stop-prechild.py')
  const argv=[terminalizer,'--runtime-root',runtime,'--authority-dir',authority,'--expected-window-sha256',sha(windowPath),
    '--expected-owner-sha256',sha(owner),'--expected-supervisor-sha256',sha(installedSupervisor),
    '--expected-issuer-fact-sha256',sha(issuerFact),'--expected-source-sha256',sha(source),
    '--expected-owned-sha256',sha(owned),'--trigger-close',trigger,'--expected-trigger-sha256',sha(trigger),
    '--recovery-repo-root',repo,'--expected-recovery-branch','main','--expected-recovery-head',recoveryHead,
    '--expected-terminalizer-sha256',sha(terminalizer),'--observed-exit-code','1']
  return {root,repo,runtime,authority,windowId,label,terminalizer,argv,owner,source,owned,issuerFact,
    windowPath,trigger,installedSupervisor,cleanup:()=>rmSync(root,{recursive:true,force:true})}
}
function setOption(argv,key,value){const index=argv.indexOf(key);assert.notEqual(index,-1);argv[index+1]=value}

function candidate(root) {
  const base=['package.json','pnpm-lock.yaml','packages/bridge-core/package.json','packages/contracts/package.json','packages/bridge-core/test/benchmarks/recording-capacity.ts','packages/bridge-core/test/benchmarks/recording-capacity-process.ts']
  for (const relative of base) { const path=join(root,relative); mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,`${relative}\n`) }
  for(let i=1;i<=234;i++){const path=join(root,'packages/bridge-core/src',`source-${String(i).padStart(3,'0')}.ts`);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,`export const v${i}=${i}\n`)}
  for(const dir of ['packages/bridge-core/test/helpers','packages/contracts/src','packages/contracts/dist']) mkdirSync(join(root,dir),{recursive:true})
  const issuer=join(root,'scripts/ci/issue-v3-capacity-queued-stop-window.py'), supervisor=join(root,'scripts/ci/capacity-phase-supervisor-v2.py')
  mkdirSync(dirname(issuer),{recursive:true});cpSync(sourceIssuer,issuer);chmodSync(issuer,0o700);writeFileSync(supervisor,'#!/usr/bin/env python3\nraise SystemExit(99)\n');chmodSync(supervisor,0o700)
  cpSync(sourcePrechildTerminalizer,join(root,'scripts/ci/terminalize-v3-capacity-queued-stop-prechild.py'))
  execFileSync('/usr/bin/git',['init','-b','main'],{cwd:root});git(root,'config','user.email','test@example.invalid');git(root,'config','user.name','Test');git(root,'add','.');git(root,'commit','-m','fixture')
  const head=git(root,'rev-parse','HEAD');writeFileSync(join(root,'packages/contracts/dist/generated.js'),'export const generated = true\n')
  return {issuer,supervisor,head}
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

function priorIssuerFailure(f, suffix = '', stage = 'core') {
  const windowId=randomUUID(),windowDirName=`objects-queued-prior-window${suffix}`,label=`objects-queued-prior-run${suffix}`
  const parent=join(f.runtime,windowDirName);mkdirSync(join(parent,'issuer-identity'),{recursive:true})
  const owner=join(parent,'owner.json'),supervisor=join(parent,'supervisor.py'),issuerFact=join(parent,'issuer-identity/owner.json')
  put(owner,{scope:'musicbridge-capacity-queued-stop-window',owner:'root',id:windowId})
  writeFileSync(supervisor,'prior installed supervisor\n');put(issuerFact,{
    schemaVersion:1,scope:'musicbridge-capacity-queued-stop-authority-issuer',windowId})
  const authorityFilesCreated=['owner.json','supervisor.py','issuer-identity/owner.json']
  if (stage === 'owned') {
    put(join(parent,'source-pins.json'),{schemaVersion:1,scope:'musicbridge-capacity-source-pins',files:{}})
    put(join(parent,'owned-roots.json'),{schemaVersion:1,scope:'musicbridge-capacity-owned-roots',access:'count-only',windowId,roots:[]})
    authorityFilesCreated.push('source-pins.json','owned-roots.json')
  }
  const failure=join(parent,'issuer-failure.json')
  put(failure,{schemaVersion:1,scope:'musicbridge-capacity-queued-stop-authority-issuer-failure',state:'TERMINAL_ISSUER_FAILURE',
    windowId,windowDirName,label,errorCode:'SOURCE_CANDIDATE',
    authorityFilesCreated,windowWritten:false,replayAllowed:false,
    recordedAt:'2026-08-30T03:58:58.329+00:00'})
  return {parent,windowId,windowDirName,label,errorCode:'SOURCE_CANDIDATE',failure,
    argv:[failure,sha(failure),sha(owner),sha(supervisor),sha(issuerFact),windowId,windowDirName,label,'SOURCE_CANDIDATE']}
}

function priorPrechildFailure(f, suffix = '') {
  const windowId=randomUUID(),windowDirName=`objects-queued-prechild-window${suffix}`,
    label=`objects-queued-prechild-run${suffix}`
  const parent=join(f.runtime,windowDirName),issuerIdentity=join(parent,'issuer-identity');mkdirSync(issuerIdentity,{recursive:true})
  const owner=join(parent,'owner.json'),supervisor=join(parent,'supervisor.py'),issuerFact=join(issuerIdentity,'owner.json')
  const source=join(parent,'source-pins.json'),owned=join(parent,'owned-roots.json'),window=join(parent,'window.json')
  put(owner,{scope:'musicbridge-capacity-queued-stop-window',owner:'root',id:windowId})
  writeFileSync(supervisor,'prior installed supervisor\n')
  put(issuerFact,{schemaVersion:1,scope:'musicbridge-capacity-queued-stop-authority-issuer',windowId,
    candidateRepository:{root:f.root,branch:'main',head:f.head}})
  put(source,{schemaVersion:1,scope:'musicbridge-capacity-source-pins',files:{}})
  put(owned,{schemaVersion:1,scope:'musicbridge-capacity-owned-roots',access:'count-only',windowId,roots:[]})
  put(window,{schemaVersion:1,scope:'musicbridge-capacity-queued-stop-window',owner:'root',id:windowId,state:'approved',
    phase:'queued-stop',profile:'objects-limit',label,candidateRepository:{root:f.root,branch:'main',head:f.head},
    supervisor:{path:supervisor,sha256:sha(supervisor)},sourceManifest:{file:'source-pins.json',sha256:sha(source)},
    ownedManifest:{file:'owned-roots.json',sha256:sha(owned)}})
  const trigger=join(f.runtime,`objects-generation-prechild${suffix}-close.json`)
  put(trigger,{schemaVersion:1,scope:'musicbridge-capacity-generation-close',window:{id:randomUUID(),label:'objects-seed'}})
  const terminalizer=join(f.root,'scripts/ci/terminalize-v3-capacity-queued-stop-prechild.py')
  const failure=join(parent,'prechild-failure.json')
  put(failure,{schemaVersion:1,scope:'musicbridge-capacity-queued-stop-prechild-failure',
    state:'TERMINAL_PRECHILD_CONTROL_FAILURE',windowId,windowDirName,label,
    failure:'QUEUED_STOP_REPLAY_AUDIT_TYPE_ERROR',observedExitCode:1,windowSha256:sha(window),
    authorityFiles:{ownerSha256:sha(owner),supervisorSha256:sha(supervisor),issuerFactSha256:sha(issuerFact),
      sourceManifestSha256:sha(source),ownedManifestSha256:sha(owned)},
    trigger:{path:trigger,sha256:sha(trigger),scope:'musicbridge-capacity-generation-close',
      windowId:JSON.parse(readFileSync(trigger)).window.id,label:'objects-seed',fieldType:'dict',
      role:'isolated-reproduction-witness-not-historical-order'},
    reproduction:{type:'TypeError',messageCode:'UNHASHABLE_DICT',fullRuntimeReproduced:true,
      isolatedWitnessReproduced:true},authorityAdmission:'NOT_RUN',
    supervisionStarted:false,benchmarkStarted:false,childSpawned:false,outputCreated:false,sampleCount:0,
    windowConsumed:true,deviceOpened:false,formalReady:false,gateB:'NOT_RUN',replayAllowed:false,
    replayPolicy:'terminal-window-id-and-label-never-reuse',
    recovery:{repositoryRoot:f.root,branch:'main',head:f.head,scriptPath:terminalizer,
      scriptRelativePath:'scripts/ci/terminalize-v3-capacity-queued-stop-prechild.py',scriptSha256:sha(terminalizer)},
    recordedAt:'2026-08-30T08:00:00.000+00:00'})
  return {parent,windowId,windowDirName,label,failure,
    argv:[failure,sha(failure),sha(owner),sha(supervisor),sha(issuerFact),sha(source),sha(owned),sha(window),
      windowId,windowDirName,label,'QUEUED_STOP_REPLAY_AUDIT_TYPE_ERROR']}
}

function priorProcessFailure(f, suffix = '') {
  const windowId=randomUUID(),windowDirName=`objects-queued-process-window${suffix}`,
    label=`objects-queued-process-run${suffix}`
  const parent=join(f.runtime,windowDirName),issuerIdentity=join(parent,'issuer-identity'),
    supervisionDirectory=join(parent,'supervision')
  mkdirSync(issuerIdentity,{recursive:true});mkdirSync(supervisionDirectory)
  const owner=join(parent,'owner.json'),supervisor=join(parent,'supervisor.py'),
    issuerFact=join(issuerIdentity,'owner.json'),source=join(parent,'source-pins.json'),
    owned=join(parent,'owned-roots.json'),window=join(parent,'window.json'),close=join(parent,'close.json'),
    supervision=join(supervisionDirectory,'supervisor.json'),
    supervisorStart=join(supervisionDirectory,'supervisor-start.json'),
    stdout=join(supervisionDirectory,'stdout.log'),stderr=join(supervisionDirectory,'stderr.log')
  put(owner,{scope:'musicbridge-capacity-queued-stop-window',owner:'root',id:windowId})
  cpSync(f.supervisor,supervisor)
  const candidateRepository={root:f.root,branch:'main',head:f.head}
  const measureCarryover={window:{path:'/measure/window.json',id:randomUUID(),sha256:'1'.repeat(64)},
    close:{path:'/measure/close.json',sha256:'2'.repeat(64)},ownedManifest:{path:'/measure/owned.json',sha256:'3'.repeat(64)},
    sourceManifest:{path:'/measure/source.json',sha256:'4'.repeat(64)},supervision:{path:'/measure/supervision.json',sha256:'5'.repeat(64)},
    supervisor:{path:'/measure/supervisor.py',sha256:'6'.repeat(64)},output:{path:'/measure/output',label:'measure',commandSha256:'7'.repeat(64)},
    measureRootRecovery:{path:'/measure/recovery.json',sha256:'8'.repeat(64)}}
  put(issuerFact,{schemaVersion:1,scope:'musicbridge-capacity-queued-stop-authority-issuer',windowId,
    issuerRepository:{root:f.root,branch:'main',head:f.head,relativePath:'scripts/ci/issue-v3-capacity-queued-stop-window.py',sha256:sha(f.issuer)},
    candidateRepository,supervisorSource:{path:supervisor,relativePath:'scripts/ci/capacity-phase-supervisor-v2.py',sha256:sha(supervisor)},
    toolchain:{node:{path:f.node,sha256:sha(f.node)},tsxLoader:{path:f.tsx,sha256:sha(f.tsx)},consumerPython:{path:python,sha256:sha(python)}},
    buildHelper:{path:f.issuer,relativePath:'scripts/ci/issue-v3-capacity-window.py',sha256:sha(f.issuer)},
    buildToolchain:{node:{path:f.node,sha256:sha(f.node)},nodeLibrary:{path:f.tsx,sha256:sha(f.tsx)},
      typescriptCompiler:{path:f.tsx,sha256:sha(f.tsx)},typescriptLibraryManifestSha256:'a'.repeat(64)},
    build:{candidateHead:f.head,inputs:{},command:[],environment:{},timeoutMs:1,compilerExitCode:0,
      compilerOutputBytes:0,privateToolchain:{},outputs:{}},issuerFailureCarryover:[{failure:'issuer'}],
    prechildFailureCarryover:[{failure:'prechild'}],measureCarryover})
  const sourceFiles={};for(let index=0;index<241;index++)sourceFiles[`source-${index}`]=String((index%9)+1).repeat(64)
  put(source,{schemaVersion:1,scope:'musicbridge-capacity-source-pins',files:sourceFiles})
  const historicalRoots=[]
  for(let index=0;index<73;index++) {const historical=join(f.runtime,`process-historical${suffix}-${index}`)
    mkdirSync(historical);put(join(historical,'owner.json'),{scope:'historical',index});historicalRoots.push(rootIdentity(historical,'owner.json'))}
  const roots=[...historicalRoots,rootIdentity(parent,'owner.json'),rootIdentity(issuerIdentity,'owner.json')]
  put(owned,{schemaVersion:1,scope:'musicbridge-capacity-owned-roots',access:'count-only',windowId,roots})
  const seedLabel='r023-objects-limit-seed-03',seed={label:seedLabel,
    metadataSha256:'632d8e4b0c01ffec07adc72344e7bcc877e5f1d764e7745af856c6ba44492309',
    snapshotSha256:'7ec9b3bed1642503cc9fcee70c6156b54eb43834b0a457050ec51607f2e1ab3a',
    fixtureOwnerSha256:'8e885bdee2c2acd6ba6b189f6de6c88bcb5e3a4b84d838a9b56e30987eb716c1'}
  put(window,{schemaVersion:1,scope:'musicbridge-capacity-queued-stop-window',owner:'root',id:windowId,
    state:'approved',phase:'queued-stop',profile:'objects-limit',label,seedLabel,seed,n:105,
    issuerFailureCarryoverCount:1,prechildFailureCarryoverCount:1,
    issuedAt:'2026-08-30T10:51:28.210+00:00',deadlineAt:'2026-08-30T11:06:28.210+00:00',
    limits:{executionMs:50000,killGraceMs:1000,closeMs:2000,minimumFreeBytes:10737418240,maximumOwnedBytes:17179869184},
    ownedManifest:{file:'owned-roots.json',sha256:sha(owned)},sourceManifest:{file:'source-pins.json',sha256:sha(source)},
    queuedStopPlan:{warmupCount:5,formalCount:100,sampleCount:105,activeCloneMaximum:1,snapshotBytes:1990471680,
      evidenceAllowanceBytes:268435456,plannedBytes:2258907136,model:'serial-single-clone-plus-bounded-growth-v1',aggregateAudit:'queued-stop-aggregate-budget.jsonl'},
    supervisor:{path:supervisor,sha256:sha(supervisor)},toolchain:JSON.parse(readFileSync(issuerFact)).toolchain,
    issuer:{path:f.issuer,sha256:sha(f.issuer),fact:{path:issuerFact,sha256:sha(issuerFact)}},candidateRepository,measureCarryover})
  writeFileSync(stdout,'')
  writeFileSync(stderr,'CAPACITY_PHASE_OPERATION_FAILED\n'+
    '(node:313) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n'+
    '(Use `node --trace-warnings ...` to show where the warning was created)\n')
  const stdoutFact={path:stdout,exists:true,size:readFileSync(stdout).length,sha256:sha(stdout)},
    stderrFact={path:stderr,exists:true,size:readFileSync(stderr).length,sha256:sha(stderr)},
    queuedStop={outputDirectory:join(parent,label),verifiedComplete:false,verifiedPassed:false,fileCount:0,
      sampleCount:0,uniqueChildPids:0,aggregateBudgetValid:false,unexpectedEntries:[]}
  put(supervisorStart,{pid:313,pgid:313,command:[f.node,'--import',f.tsx,join(f.root,'packages/bridge-core/test/benchmarks/recording-capacity-process.ts'),
    '--phase','queued-stop','--profile','objects-limit','--label',label,'--seed-label',seedLabel,
    '--window',window,'--window-sha256',sha(window),'--owned-roots',owned,'--owned-roots-sha256',sha(owned)],
    managedProcessGroup:true,startedMonotonic:1,deadlineMonotonic:2,cwd:f.root,
    environmentKeys:['CI','LANG','LC_ALL','PATH','TMPDIR','TZ'],environment:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C',LC_ALL:'C',TZ:'UTC',CI:'1',TMPDIR:'/tmp'},
    stdin:'DEVNULL',stdout,stderr})
  put(supervision,{passed:false,failure:'PROCESS_EXIT',pid:313,pgid:313,code:1,exitSignal:null,
    signals:[],groupEmpty:true,zombies:[],elapsedMs:650.4,managedProcessGroup:true,stdout:stdoutFact,stderr:stderrFact,queuedStop})
  const authority={authorityStable:true,windowStable:true,ownerStable:true,sourceManifestStable:true,
    ownedManifestStable:true,sourcePinsValid:true,ownedRootsValid:true,measureCarryoverValid:true,
    issuerFailureCarryoverValid:true,prechildFailureCarryoverValid:true,spaceValid:true,
    windowSha256Observed:sha(window),ownerSha256Observed:sha(owner),sourceFileCount:241,ownedRootCount:75,
    issuerFailureCount:1,prechildFailureCount:1,ownedBytes:1,plannedBytes:2258907136,
    remainingPlannedBytes:0,availableBytes:20000000000,candidateRepository,toolchainStable:true,issuerStable:true}
  put(close,{schemaVersion:1,scope:'musicbridge-capacity-queued-stop-window-close',windowId,profile:'objects-limit',label,
    seedLabel,closedAt:'2026-08-30T10:51:58.666686+00:00',state:'failed',failure:'PROCESS_EXIT',
    pid:313,pgid:313,managedProcessGroup:true,code:1,exitSignal:null,signals:[],groupEmpty:true,zombies:[],elapsedMs:650.4,
    windowSha256:sha(window),sourceManifestSha256:sha(source),ownedManifestSha256:sha(owned),seed,measureCarryover,
    authorityAdmission:{...authority,remainingPlannedBytes:2258907136},authorityTerminal:authority,queuedStop,
    supervisorSha256:sha(supervision),stdout:stdoutFact,stderr:stderrFact,deviceOpened:false,formalReady:false,
    gateB:'NOT_RUN',replayPolicy:'terminal-window-id-and-label-never-reuse'})
  return {parent,issuerIdentity,windowId,windowDirName,label,owner,supervisor,issuerFact,source,owned,
    window,close,historicalRoots,stderr,stdout,supervision,supervisorStart,
    argv:[close,sha(close),sha(owner),sha(supervisor),sha(issuerFact),sha(source),sha(owned),sha(window),
      sha(supervision),sha(supervisorStart),sha(stdout),sha(stderr),windowId,windowDirName,label,'PROCESS_EXIT']}
}

function processFailureFact(value) {
  const [close,closeSha,ownerSha,supervisorSha,issuerFactSha,sourceSha,ownedSha,windowSha,
    supervisionSha,startSha,stdoutSha,stderrSha,windowId,windowDirName,label]=value.argv
  return {root:value.parent,windowId,windowDirName,label,failure:'PROCESS_EXIT',code:1,sampleCount:0,
    deviceOpened:false,formalReady:false,gateB:'NOT_RUN',files:{
      owner:{path:value.owner,sha256:ownerSha},supervisor:{path:value.supervisor,sha256:supervisorSha},
      issuerFact:{path:value.issuerFact,sha256:issuerFactSha},sourceManifest:{path:value.source,sha256:sourceSha},
      ownedManifest:{path:value.owned,sha256:ownedSha},window:{path:value.window,sha256:windowSha},
      close:{path:close,sha256:closeSha},supervision:{path:value.supervision,sha256:supervisionSha},
      supervisorStart:{path:value.supervisorStart,sha256:startSha},stdout:{path:value.stdout,sha256:stdoutSha},
      stderr:{path:value.stderr,sha256:stderrSha}}}
}

function linkedProcessFailure(f, mutate = () => {}) {
  const leaf=priorProcessFailure(f,'-03'),head=priorProcessFailure(f,'-05')
  const predecessor=processFailureFact(leaf)
  const fact=JSON.parse(readFileSync(head.issuerFact));fact.processFailureCarryover=[predecessor];put(head.issuerFact,fact)
  const owned=JSON.parse(readFileSync(head.owned));owned.roots.splice(0,73,...structuredClone(leaf.historicalRoots))
  owned.roots.splice(73,0,rootIdentity(leaf.parent,'owner.json'))
  owned.roots[owned.roots.length-1]=rootIdentity(head.issuerIdentity,'owner.json');put(head.owned,owned)
  head.historicalRoots=leaf.historicalRoots
  const window=JSON.parse(readFileSync(head.window));window.processFailureCarryoverCount=1
  window.issuedAt='2026-08-30T10:52:28.210+00:00';window.deadlineAt='2026-08-30T11:07:28.210+00:00'
  window.issuer.fact.sha256=sha(head.issuerFact);window.ownedManifest.sha256=sha(head.owned);put(head.window,window)
  const start=JSON.parse(readFileSync(head.supervisorStart));start.command[start.command.indexOf('--window-sha256')+1]=sha(head.window)
  start.command[start.command.indexOf('--owned-roots-sha256')+1]=sha(head.owned);put(head.supervisorStart,start)
  const authorityPatch=value=>{value.processFailureCarryoverValid=true;value.processFailureCount=1;value.ownedRootCount=76;value.windowSha256Observed=sha(head.window)}
  const close=JSON.parse(readFileSync(head.close));close.windowSha256=sha(head.window);close.ownedManifestSha256=sha(head.owned)
  authorityPatch(close.authorityAdmission);authorityPatch(close.authorityTerminal);mutate({leaf,head,predecessor,fact,owned,window,start,close})
  put(head.close,close)
  head.argv=[head.close,sha(head.close),sha(head.owner),sha(head.supervisor),sha(head.issuerFact),sha(head.source),
    sha(head.owned),sha(head.window),sha(head.supervision),sha(head.supervisorStart),sha(head.stdout),sha(head.stderr),
    head.windowId,head.windowDirName,head.label,'PROCESS_EXIT']
  return {leaf,head,predecessor}
}

function refreshProcessFailure(value) {
  const fact=JSON.parse(readFileSync(value.issuerFact)),owned=JSON.parse(readFileSync(value.owned))
  owned.roots[owned.roots.length-1]=rootIdentity(value.issuerIdentity,'owner.json');put(value.owned,owned)
  const window=JSON.parse(readFileSync(value.window));window.issuer.fact.sha256=sha(value.issuerFact)
  window.ownedManifest.sha256=sha(value.owned);put(value.window,window)
  const start=JSON.parse(readFileSync(value.supervisorStart));start.command[start.command.indexOf('--window-sha256')+1]=sha(value.window)
  start.command[start.command.indexOf('--owned-roots-sha256')+1]=sha(value.owned);put(value.supervisorStart,start)
  const supervision=JSON.parse(readFileSync(value.supervision));supervision.stdout={path:value.stdout,exists:true,size:statSync(value.stdout).size,sha256:sha(value.stdout)}
  supervision.stderr={path:value.stderr,exists:true,size:statSync(value.stderr).size,sha256:sha(value.stderr)};put(value.supervision,supervision)
  const close=JSON.parse(readFileSync(value.close));close.windowSha256=sha(value.window);close.ownedManifestSha256=sha(value.owned)
  close.authorityAdmission.windowSha256Observed=sha(value.window);close.authorityTerminal.windowSha256Observed=sha(value.window)
  close.stdout=supervision.stdout;close.stderr=supervision.stderr;close.supervisorSha256=sha(value.supervision);put(value.close,close)
  value.argv=[value.close,sha(value.close),sha(value.owner),sha(value.supervisor),sha(value.issuerFact),sha(value.source),
    sha(value.owned),sha(value.window),sha(value.supervision),sha(value.supervisorStart),sha(value.stdout),sha(value.stderr),
    value.windowId,value.windowDirName,value.label,'PROCESS_EXIT']
  return {fact,owned,window,start,supervision,close}
}

function args(f){return [f.issuer,'--repo-root',f.root,'--runtime-root',f.runtime,'--measure-window',f.window,'--expected-measure-window-id',f.measureId,'--expected-measure-window-sha256',sha(f.window),'--measure-close',f.close,'--expected-measure-close-sha256',sha(f.close),'--measure-owned-manifest',f.owned,'--expected-measure-owned-sha256',sha(f.owned),'--measure-source-manifest',f.source,'--expected-measure-source-sha256',sha(f.source),'--measure-supervision',f.supervision,'--expected-measure-supervision-sha256',sha(f.supervision),'--measure-supervisor',f.measureSupervisor,'--expected-measure-supervisor-sha256',sha(f.measureSupervisor),'--expected-measure-close-supervisor-sha256',sha(f.measureSupervisor),'--measure-output',f.measureOutput,'--expected-measure-label',f.measureLabel,'--expected-measure-output-command-sha256',sha(join(f.measureOutput,'command.json')),'--seed-label',f.seedLabel,'--expected-seed-metadata-sha256',f.seedHashes.metadataSha256,'--expected-seed-snapshot-sha256',f.seedHashes.snapshotSha256,'--expected-seed-fixture-owner-sha256',f.seedHashes.fixtureOwnerSha256,'--measure-root-recovery',join(f.runtime,'measure-root-recovery-v1','recovery.json'),'--expected-measure-root-recovery-sha256','0'.repeat(64),'--window-dir-name','objects-queued-window','--label','objects-queued-run','--profile','objects-limit','--expected-branch','main','--expected-head',f.head,'--supervisor',f.supervisor,'--expected-supervisor-sha256',sha(f.supervisor),'--node',f.node,'--expected-node-sha256',sha(f.node),'--tsx-loader',f.tsx,'--expected-tsx-loader-sha256',sha(f.tsx),'--consumer-python',python,'--expected-consumer-sha256',sha(python),'--issuer-repo-root',f.root,'--expected-issuer-branch','main','--expected-issuer-head',f.head,'--expected-issuer-sha256',sha(f.issuer),'--build-node',f.node,'--expected-build-node-sha256',sha(f.node),'--build-node-library',f.tsx,'--expected-build-node-library-sha256',sha(f.tsx),'--typescript-compiler',f.tsx,'--expected-typescript-compiler-sha256',sha(f.tsx),'--expected-typescript-library-manifest-sha256','a'.repeat(64)]}
const run=f=>spawnSync(python,args(f),{encoding:'utf8'}), cleanup=f=>rmSync(f.root,{recursive:true,force:true})
function options(f){const value={};const values=args(f);for(let i=1;i<values.length;i+=2)value[values[i].slice(2).replaceAll('-','_')]=values[i+1];return value}
function pythonCall(body,...values){const bridge=`import importlib.util,json,sys,types\ns=importlib.util.spec_from_file_location('issuer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n${body}`;return spawnSync(python,['-B','-c',bridge,sourceIssuer,...values],{encoding:'utf8'})}

function directRecoveryFixture(remapped = true) {
  const temp=realpathSync(mkdtempSync(join(tmpdir(),'queued-recovery-validator-')))
  const repo=join(temp,'repo'),remote=join(temp,'remote.git'),runtime=join(temp,'runtime')
  mkdirSync(join(repo,'scripts/ci'),{recursive:true});mkdirSync(runtime)
  cpSync(sourceRecoveryCreator,join(repo,'scripts/ci/create-v3-capacity-measure-root-recovery.py'))
  execFileSync('/usr/bin/git',['init','-b','main'],{cwd:repo});git(repo,'config','user.email','test@example.invalid');git(repo,'config','user.name','Test')
  git(repo,'add','.');git(repo,'commit','-m','recovery creator');execFileSync('/usr/bin/git',['init','--bare',remote])
  git(repo,'remote','add','origin',remote);git(repo,'push','-q','-u','origin','main')
  const head=git(repo,'rev-parse','HEAD'),windowId=randomUUID()
  const seed=join(runtime,'durable-seed'),snapshot=join(seed,'seed.sqlite');mkdirSync(seed);writeFileSync(snapshot,'durable seed input\n')
  put(join(seed,'seed.json'),{scope:'durable-seed'});const live=[rootIdentity(seed,'seed.json')]
  for(let index=1;index<63;index++){const path=join(runtime,`live-${String(index).padStart(2,'0')}`);mkdirSync(path);put(join(path,'owner.json'),{scope:'live',index});live.push(rootIdentity(path,'owner.json'))}
  const currentDevice=lstatSync(runtime).dev,historicalDevice=currentDevice+(remapped?1:0)
  for(const row of live)row.device=historicalDevice
  const fixtureOwner={id:randomUUID(),scope:'musicbridge-capacity-synthetic-only'},fixtureOwnerPath=join(temp,'fixture-owner.json');put(fixtureOwnerPath,fixtureOwner)
  const absent=[]
  for(let index=0;index<7;index++){
    const path=join(temp,`lost-${index}`),marker=index===0?{relative:'capacity-owner.json',sha256:sha(fixtureOwnerPath)}:{relative:'capacity-owner.json',sha256:String(index+1).repeat(64)}
    absent.push({path,device:historicalDevice,inode:index+1,marker})
  }
  const historical=join(runtime,'historical');mkdirSync(historical)
  const ownedPath=join(historical,'owned-roots.json'),owned={schemaVersion:1,scope:'musicbridge-capacity-owned-roots',access:'count-only',windowId,roots:[...live,...absent],futureRoots:[join(runtime,'historical-output')]};put(ownedPath,owned)
  const recoveryRoot=join(runtime,'measure-root-recovery-v1');mkdirSync(recoveryRoot);chmodSync(recoveryRoot,0o700)
  const replacements=absent.map((historicalRoot,index)=>{const path=join(recoveryRoot,`replacement-${String(index+1).padStart(3,'0')}`);mkdirSync(path);chmodSync(path,0o700);put(join(path,'owner.json'),{schemaVersion:1,scope:'musicbridge-capacity-historical-control-only',id:randomUUID(),role:'historical-control-only',historicalRoot,recovered:false});chmodSync(join(path,'owner.json'),0o400);return {...rootIdentity(path,'owner.json'),role:'historical-control-only'}})
  const tool=join(repo,'scripts/ci/create-v3-capacity-measure-root-recovery.py'),receiptPath=join(recoveryRoot,'recovery.json')
  const receipt={schemaVersion:1,scope:'musicbridge-capacity-measure-root-recovery',access:'read-only',state:'PUBLISHED',model:'exact75-v2-replacement-closure',windowId,historicalManifest:{path:ownedPath,sha256:sha(ownedPath)},liveDeviceRemap:{mode:remapped?'REMAPPED':'UNCHANGED',historicalDevice,currentDevice,liveRootCount:63},repository:{root:repo,branch:'main',head,clean:true,pushedHead:true},recoveryTool:{path:tool,relativePath:'scripts/ci/create-v3-capacity-measure-root-recovery.py',workingSha256:sha(tool),gitBlobSha256:sha(tool)},mappings:absent.map((historicalRoot,index)=>({historicalRoot,state:'LOST',recovered:false,replacementRoot:replacements[index]})),activeBenchmarkInput:{model:'durable-seed-snapshot',path:snapshot,sha256:sha(snapshot)},contentRecovered:false,historicalManifestRewritten:false,deviceOpened:false,formalReady:false,gateB:'NOT_RUN'}
  put(receiptPath,receipt);chmodSync(receiptPath,0o400)
  const options={measure_root_recovery:receiptPath,expected_measure_root_recovery_sha256:sha(receiptPath),expected_measure_window_id:windowId,expected_measure_owned_sha256:sha(ownedPath),repo_root:repo,expected_branch:'main',expected_head:head,expected_seed_snapshot_sha256:sha(snapshot),expected_seed_fixture_owner_sha256:sha(fixtureOwnerPath)}
  return {temp,repo,remote,runtime,seed,snapshot,ownedPath,owned,recoveryRoot,receiptPath,receipt,replacements,absent,options,tool,cleanup:()=>rmSync(temp,{recursive:true,force:true})}
}

function rewriteDirectRecovery(f, mutate) {
  const receipt=JSON.parse(readFileSync(f.receiptPath));mutate(receipt);chmodSync(f.receiptPath,0o600);rmSync(f.receiptPath);put(f.receiptPath,receipt);chmodSync(f.receiptPath,0o400);f.options.expected_measure_root_recovery_sha256=sha(f.receiptPath)
}

function validateDirectRecovery(f) {
  return pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));owned=json.loads(m.Path(sys.argv[4]).read_text());\ntry:\n value=m.validate_measure_root_recovery(o,m.Path(sys.argv[3]),m.Path(sys.argv[4]),owned,m.Path(sys.argv[5]),m.Path(sys.argv[6]));print(json.dumps({'live':len(value['liveRoots']),'replacement':len(value['replacementRoots']),'input':value['activeBenchmarkInput']}))\nexcept m.IssueError as error:\n print(error);raise SystemExit(1)",JSON.stringify(f.options),f.runtime,f.ownedPath,f.seed,f.snapshot)
}

function processRecoveryLineageFixture() {
  const f=directRecoveryFixture(),currentRoot=join(f.runtime,'measure-root-recovery-v2')
  mkdirSync(currentRoot);chmodSync(currentRoot,0o700)
  const currentReplacements=f.absent.map((historicalRoot,index)=>{const path=join(currentRoot,`replacement-${String(index+1).padStart(3,'0')}`);mkdirSync(path);put(join(path,'owner.json'),{schemaVersion:1,scope:'musicbridge-capacity-historical-control-only',id:randomUUID(),role:'historical-control-only',historicalRoot,recovered:false});return {...rootIdentity(path,'owner.json'),role:'historical-control-only'}})
  const stable=f.owned.roots.slice(0,63).map(row=>rootIdentity(row.path,row.marker.relative))
  const suffix=[]
  for(const name of ['measure-output','issuer-failure','prechild-failure']){const path=join(f.runtime,`lineage-${name}`);mkdirSync(path);put(join(path,'owner.json'),{scope:name});suffix.push(rootIdentity(path,'owner.json'))}
  const currentMappings=f.absent.map((historicalRoot,index)=>({historicalRoot,state:'LOST',recovered:false,replacementRoot:currentReplacements[index]}))
  const historicalMeasure={measureRootRecovery:{path:f.receiptPath,sha256:sha(f.receiptPath)},window:{id:f.receipt.windowId},ownedManifest:f.receipt.historicalManifest,candidateRepository:{root:f.repo,branch:'main',head:f.options.expected_head}}
  return {...f,historicalMeasure,currentMappings,oldInherited:[...stable,...f.replacements.map(({role,...row})=>row),...suffix],currentRoots:[...stable,...currentReplacements.map(({role,...row})=>row),...suffix]}
}

function validateProcessLineage(f,historicalMeasure=f.historicalMeasure,currentMappings=f.currentMappings,currentRoots=f.currentRoots,oldInherited=f.oldInherited){return pythonCall("try:\n value=m.validate_process_recovery_lineage(m.Path(sys.argv[2]),json.loads(sys.argv[3]),json.loads(sys.argv[4]),json.loads(sys.argv[5]),json.loads(sys.argv[6]));print(json.dumps(value))\nexcept m.IssueError as error:\n print(error);raise SystemExit(1)",f.runtime,JSON.stringify(historicalMeasure),JSON.stringify(oldInherited),JSON.stringify(currentRoots),JSON.stringify(currentMappings))}

test('pre-child terminalizer只封存零样本控制面崩溃且禁止重复写入',()=>{
  const f=prechildTerminalFixture()
  try {
    const first=spawnSync(python,['-B',...f.argv],{encoding:'utf8'})
    assert.equal(first.status,0,first.stderr)
    const receiptPath=join(f.authority,'prechild-failure.json')
    assert.equal(existsSync(receiptPath),true)
    const receipt=JSON.parse(readFileSync(receiptPath))
    assert.equal(receipt.scope,'musicbridge-capacity-queued-stop-prechild-failure')
    assert.equal(receipt.state,'TERMINAL_PRECHILD_CONTROL_FAILURE')
    assert.equal(receipt.windowId,f.windowId)
    assert.equal(receipt.label,f.label)
    assert.equal(receipt.failure,'QUEUED_STOP_REPLAY_AUDIT_TYPE_ERROR')
    assert.equal(receipt.benchmarkStarted,false)
    assert.equal(receipt.childSpawned,false)
    assert.equal(receipt.sampleCount,0)
    assert.equal(receipt.deviceOpened,false)
    assert.equal(receipt.replayAllowed,false)
    assert.deepEqual(receipt.reproduction,{type:'TypeError',messageCode:'UNHASHABLE_DICT',
      fullRuntimeReproduced:true,isolatedWitnessReproduced:true})
    assert.equal(receipt.trigger.role,'isolated-reproduction-witness-not-historical-order')
    assert.equal(existsSync(join(f.authority,'close.json')),false)
    assert.equal(existsSync(join(f.authority,'.prechild-failure.pending.json')),false)
    assert.equal(lstatSync(receiptPath).nlink,1)
    const receiptSha=sha(receiptPath)
    const second=spawnSync(python,['-B',...f.argv],{encoding:'utf8'})
    assert.equal(second.status,1)
    assert.equal(sha(receiptPath),receiptSha)
  } finally { f.cleanup() }
})

test('pre-child收据可从完整pending无覆盖发布且最终文件不是双链接',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'queued-prechild-publish-'))),
    final=join(root,'prechild-failure.json'),pending=join(root,'.prechild-failure.pending.json')
  try {
    const persisted={scope:'test-prechild',state:'pending-resume',recordedAt:'2026-08-30T08:00:00.000Z'}
    put(pending,persisted)
    chmodSync(pending,0o400)
    const expected={...persisted,recordedAt:'2026-08-30T08:00:01.000Z'}
    const code="import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('terminalizer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(m.publish_json(sys.argv[2],json.loads(sys.argv[3])))"
    const resumed=spawnSync(python,['-B','-c',code,sourcePrechildTerminalizer,final,JSON.stringify(expected)],{encoding:'utf8'})
    assert.equal(resumed.status,0,resumed.stderr)
    assert.equal(existsSync(pending),false)
    assert.equal(existsSync(final),true)
    assert.equal(lstatSync(final).nlink,1)
    assert.equal(JSON.parse(readFileSync(final)).recordedAt,persisted.recordedAt)
    const duplicate=spawnSync(python,['-B','-c',code,sourcePrechildTerminalizer,final,JSON.stringify(expected)],{encoding:'utf8'})
    assert.notEqual(duplicate.status,0)
    assert.equal(lstatSync(final).nlink,1)
  } finally { rmSync(root,{recursive:true,force:true}) }
})

test('pre-child terminalizer入口收敛仅pending与final+pending两种中断态',()=>{
  for(const stage of ['pending-only','linked-final']){
    const f=prechildTerminalFixture()
    try{
      const initial=spawnSync(python,['-B',...f.argv],{encoding:'utf8'})
      assert.equal(initial.status,0,initial.stderr)
      const final=join(f.authority,'prechild-failure.json')
      const pending=join(f.authority,'.prechild-failure.pending.json')
      if(stage==='pending-only') renameSync(final,pending)
      else linkSync(final,pending)
      const resumed=spawnSync(python,['-B',...f.argv],{encoding:'utf8'})
      assert.equal(resumed.status,0,`${stage}: ${resumed.stderr}`)
      assert.equal(existsSync(pending),false)
      assert.equal(existsSync(final),true)
      assert.equal(lstatSync(final).nlink,1)
      assert.equal(lstatSync(final).mode & 0o777,0o400)
    }finally{f.cleanup()}
  }
})

test('pre-child terminalizer拒绝非0400 pending且不发布final',()=>{
  const f=prechildTerminalFixture()
  try{
    const initial=spawnSync(python,['-B',...f.argv],{encoding:'utf8'})
    assert.equal(initial.status,0,initial.stderr)
    const final=join(f.authority,'prechild-failure.json')
    const pending=join(f.authority,'.prechild-failure.pending.json')
    renameSync(final,pending);chmodSync(pending,0o600)
    const resumed=spawnSync(python,['-B',...f.argv],{encoding:'utf8'})
    assert.equal(resumed.status,1,resumed.stdout)
    assert.match(resumed.stderr,/PENDING_RECEIPT/u)
    assert.equal(existsSync(final),false)
  }finally{f.cleanup()}
})

test('pre-child terminalizer把同内容touch识别为authority drift',()=>{
  const f=prechildTerminalFixture()
  try{
    const code=`import importlib.util,os,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('terminalizer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\no=m.parse_args(sys.argv[2:])\ndef mutate(*args):\n p=Path(o.authority_dir)/'source-pins.json';v=p.stat();os.utime(p,ns=(v.st_atime_ns,v.st_mtime_ns+1000000000));return {'type':'TypeError','messageCode':'UNHASHABLE_DICT','fullRuntimeReproduced':True,'isolatedWitnessReproduced':True}\nm.reproduce_failure=mutate\ntry:m.terminalize(o)\nexcept m.TerminalizeError as e:print(e);raise SystemExit(1)\nraise SystemExit(0)`
    const observed=spawnSync(python,['-B','-c',code,...f.argv],{encoding:'utf8'})
    assert.equal(observed.status,1,observed.stderr)
    assert.match(observed.stdout,/AUTHORITY_DRIFT/u)
    assert.equal(existsSync(join(f.authority,'prechild-failure.json')),false)
  }finally{f.cleanup()}
})

test('pre-child terminalizer拒绝symlink authority与runtime根旁路输出',()=>{
  for (const mutate of [
    f=>{
      const issuerIdentity=join(f.authority,'issuer-identity'),outside=join(f.root,'issuer-identity-outside')
      renameSync(issuerIdentity,outside);symlinkSync(outside,issuerIdentity)
    },
    f=>mkdirSync(join(f.runtime,f.label)),
  ]) {
    const f=prechildTerminalFixture()
    try {
      mutate(f)
      const observed=spawnSync(python,['-B',...f.argv],{encoding:'utf8'})
      assert.equal(observed.status,1,observed.stdout)
      assert.equal(existsSync(join(f.authority,'prechild-failure.json')),false)
    } finally { f.cleanup() }
  }
})

test('pre-child terminalizer对畸形authority、candidate与witness返回域错误而非INTERNAL',()=>{
  const cases=[
    {code:'AUTHORITY_IDENTITY',mutate:f=>{
      put(f.source,[]);setOption(f.argv,'--expected-source-sha256',sha(f.source))
      const window=JSON.parse(readFileSync(f.windowPath));window.sourceManifest.sha256=sha(f.source);put(f.windowPath,window)
      setOption(f.argv,'--expected-window-sha256',sha(f.windowPath))
    }},
    {code:'AUTHORITY_IDENTITY',mutate:f=>{
      put(f.owned,[]);setOption(f.argv,'--expected-owned-sha256',sha(f.owned))
      const window=JSON.parse(readFileSync(f.windowPath));window.ownedManifest.sha256=sha(f.owned);put(f.windowPath,window)
      setOption(f.argv,'--expected-window-sha256',sha(f.windowPath))
    }},
    {code:'CANDIDATE_IDENTITY',mutate:f=>{
      const window=JSON.parse(readFileSync(f.windowPath)),fact=JSON.parse(readFileSync(f.issuerFact))
      window.candidateRepository.root={};fact.candidateRepository=window.candidateRepository
      put(f.windowPath,window);put(f.issuerFact,fact)
      setOption(f.argv,'--expected-window-sha256',sha(f.windowPath))
      setOption(f.argv,'--expected-issuer-fact-sha256',sha(f.issuerFact))
    }},
    {code:'TRIGGER_IDENTITY',mutate:f=>{
      put(f.trigger,[]);setOption(f.argv,'--expected-trigger-sha256',sha(f.trigger))
    }},
  ]
  for(const item of cases){const f=prechildTerminalFixture();try{
    item.mutate(f);const observed=spawnSync(python,['-B',...f.argv],{encoding:'utf8'})
    assert.equal(observed.status,1,observed.stdout)
    assert.match(observed.stderr,new RegExp(`=${item.code}$`,'mu'))
    assert.doesNotMatch(observed.stderr,/=INTERNAL/u)
    assert.equal(existsSync(join(f.authority,'prechild-failure.json')),false)
  }finally{f.cleanup()}}
})

test('queued-stop issuer生产入口存在且拒绝空参数',()=>{assert.equal(existsSync(sourceIssuer),true);const r=spawnSync(python,[sourceIssuer],{encoding:'utf8'});assert.equal(r.status,2);assert.match(r.stderr,/required/u)})
test('validate_measure_root_recovery直接接受统一设备代际映射的真实63 live加7 absent',()=>{const f=directRecoveryFixture();try{const r=validateDirectRecovery(f);assert.equal(r.status,0,r.stdout+r.stderr);assert.deepEqual(JSON.parse(r.stdout),{live:63,replacement:7,input:{model:'durable-seed-snapshot',path:f.snapshot,sha256:sha(f.snapshot)}});assert.deepEqual(JSON.parse(readFileSync(f.receiptPath)).liveDeviceRemap,{mode:'REMAPPED',historicalDevice:f.owned.roots[0].device,currentDevice:lstatSync(f.runtime).dev,liveRootCount:63})}finally{f.cleanup()}})
test('validate_measure_root_recovery由相同历史与当前device派生UNCHANGED',()=>{const f=directRecoveryFixture(false);try{const r=validateDirectRecovery(f);assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(readFileSync(f.receiptPath)).liveDeviceRemap.mode,'UNCHANGED')}finally{f.cleanup()}})
test('validate_measure_root_recovery拒绝非exact或不自洽liveDeviceRemap及设备集合',async t=>{
  const cases=[
    ['缺remap',f=>rewriteDirectRecovery(f,r=>{delete r.liveDeviceRemap})],
    ['remap夹带',f=>rewriteDirectRecovery(f,r=>{r.liveDeviceRemap.extra=true})],
    ['mode不由device派生',f=>rewriteDirectRecovery(f,r=>{r.liveDeviceRemap.mode='UNCHANGED'})],
    ['部分映射',f=>rewriteDirectRecovery(f,r=>{r.liveDeviceRemap.liveRootCount=62})],
    ['混合历史device',f=>{f.owned.roots[0].device+=1;put(f.ownedPath,f.owned);f.options.expected_measure_owned_sha256=sha(f.ownedPath);rewriteDirectRecovery(f,r=>{r.historicalManifest.sha256=sha(f.ownedPath)})}],
    ['live inode漂移',f=>{f.owned.roots[0].inode+=1;put(f.ownedPath,f.owned);f.options.expected_measure_owned_sha256=sha(f.ownedPath);rewriteDirectRecovery(f,r=>{r.historicalManifest.sha256=sha(f.ownedPath)})}],
    ['live marker漂移',f=>writeFileSync(join(f.seed,'seed.json'),'marker drift\n')],
    ['混合当前device声明',f=>rewriteDirectRecovery(f,r=>{r.liveDeviceRemap.currentDevice+=1})],
    ['replacement非当前device',f=>rewriteDirectRecovery(f,r=>{r.mappings[0].replacementRoot.device+=1})],
  ]
  for(const [name,mutate] of cases)await t.test(name,()=>{const f=directRecoveryFixture();try{mutate(f);const r=validateDirectRecovery(f);assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/MEASURE_ROOT_RECOVERY/u)}finally{f.cleanup()}})
})
test('validate_measure_root_recovery直接拒绝权限、symlink、hardlink、inode与目录项漂移',async t=>{
  const cases=[
    ['receipt权限',f=>chmodSync(f.receiptPath,0o600)],
    ['recovery目录权限',f=>chmodSync(f.recoveryRoot,0o755)],
    ['receipt symlink',f=>{const real=`${f.receiptPath}.real`;renameSync(f.receiptPath,real);symlinkSync(real,f.receiptPath)}],
    ['marker hardlink',f=>{const marker=join(f.replacements[0].path,'owner.json'),real=`${marker}.real`;renameSync(marker,real);linkSync(real,marker)}],
    ['replacement inode',f=>rewriteDirectRecovery(f,r=>{r.mappings[0].replacementRoot.inode+=1})],
    ['replacement entries',f=>writeFileSync(join(f.replacements[0].path,'extra'),'drift\n')],
  ]
  for(const [name,mutate] of cases)await t.test(name,()=>{const f=directRecoveryFixture();try{mutate(f);const r=validateDirectRecovery(f);assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/MEASURE_ROOT_RECOVERY/u)}finally{f.cleanup()}})
})
test('validate_measure_root_recovery直接拒绝Git dirty、未推送HEAD、blob漂移与旧根重现',async t=>{
  const cases=[
    ['dirty',f=>writeFileSync(join(f.repo,'dirty.txt'),'dirty\n')],
    ['upstream',f=>{writeFileSync(join(f.repo,'local.txt'),'local\n');git(f.repo,'add','local.txt');git(f.repo,'commit','-m','local only');const head=git(f.repo,'rev-parse','HEAD');f.options.expected_head=head;rewriteDirectRecovery(f,r=>{r.repository.head=head})}],
    ['blob',f=>rewriteDirectRecovery(f,r=>{r.recoveryTool.workingSha256='0'.repeat(64);r.recoveryTool.gitBlobSha256='0'.repeat(64)})],
    ['旧根重现',f=>{mkdirSync(f.absent[0].path);put(join(f.absent[0].path,'capacity-owner.json'),{scope:'reappeared'})}],
  ]
  for(const [name,mutate] of cases)await t.test(name,()=>{const f=directRecoveryFixture();try{mutate(f);const r=validateDirectRecovery(f);assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/MEASURE_ROOT_RECOVERY/u)}finally{f.cleanup()}})
})
test('validate_measure_root_recovery拒绝replacement或第二快照冒充durable seed输入',async t=>{
  for(const mode of ['replacement','second-snapshot'])await t.test(mode,()=>{const f=directRecoveryFixture();try{rewriteDirectRecovery(f,r=>{if(mode==='replacement')r.activeBenchmarkInput={model:'durable-seed-snapshot',path:f.replacements[0].path,sha256:r.mappings[0].replacementRoot.marker.sha256};else{const other=join(f.seed,'other.sqlite');writeFileSync(other,'other seed\n');r.activeBenchmarkInput={model:'durable-seed-snapshot',path:other,sha256:sha(other)}}});const r=validateDirectRecovery(f);assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/MEASURE_ROOT_RECOVERY_INPUT/u)}finally{f.cleanup()}})
})
test('自洽synthetic measure也必须被生产冻结window06身份拒绝',()=>{const f=fixture();try{const r=run(f);assert.equal(r.status,1);assert.match(r.stderr,/FROZEN_MEASURE/u);assert.equal(existsSync(join(f.runtime,'objects-queued-window')),false)}finally{cleanup(f)}})
test('纯payload构造冻结toolchain、failure count与issuer事实且不提供发行override',()=>{const h='a'.repeat(64),rootRecovery={path:'/runtime/measure-root-recovery-v1/recovery.json',sha256:h},kwargs={window_id:randomUUID(),label:'objects-queued-run',seed_label:'objects-seed',seed:{label:'objects-seed',metadataSha256:h,snapshotSha256:h,fixtureOwnerSha256:h},issued_at:'2026-08-30T00:00:00.000+00:00',deadline_at:'2026-08-30T00:15:00.000+00:00',owned_sha:h,source_sha:h,plan:{warmupCount:5,formalCount:100,sampleCount:105,activeCloneMaximum:1,snapshotBytes:1990471680,evidenceAllowanceBytes:268435456,plannedBytes:2258907136,model:'serial-single-clone-plus-bounded-growth-v1',aggregateAudit:'queued-stop-aggregate-budget.jsonl'},issuer_failure_count:1,prechild_failure_count:1,process_failure_count:1,installed_supervisor:'/authority/supervisor.py',supervisor_sha:h,candidate_root:'/candidate',candidate_branch:'main',candidate_head:'b'.repeat(40),measure_facts:{measureRootRecovery:rootRecovery},node:'/tool/node',node_sha:h,tsx:'/tool/loader.mjs',tsx_sha:h,consumer:'/tool/python',consumer_sha:h,issuer_path:'/candidate/scripts/ci/issue-v3-capacity-queued-stop-window.py',issuer_sha:h,issuer_fact_path:'/authority/issuer-identity/owner.json',issuer_fact_sha:h};const r=pythonCall("print(json.dumps(m.build_window_payload(**json.loads(sys.argv[2]))))",JSON.stringify(kwargs));assert.equal(r.status,0,r.stderr);const window=JSON.parse(r.stdout);assert.deepEqual(window.toolchain,{node:{path:kwargs.node,sha256:h},tsxLoader:{path:kwargs.tsx,sha256:h},consumerPython:{path:kwargs.consumer,sha256:h}});assert.deepEqual(window.issuer,{path:kwargs.issuer_path,sha256:h,fact:{path:kwargs.issuer_fact_path,sha256:h}});assert.deepEqual(window.measureCarryover.measureRootRecovery,rootRecovery);assert.equal(window.issuerFailureCarryoverCount,1);assert.equal(window.prechildFailureCarryoverCount,1);assert.equal(window.processFailureCarryoverCount,1);assert.equal(window.queuedStopPlan.plannedBytes,2258907136)})
test('纯validator仍拒绝measure非精确PASS',()=>{const f=fixture();try{const close=JSON.parse(readFileSync(f.close));close.measurement.thresholdPassed=false;put(f.close,close);const o=options(f);o.expected_measure_close_sha256=sha(f.close);const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));\ntry:m.validate_measure(o,m.Path(sys.argv[3]))\nexcept m.IssueError as e:print(e);raise SystemExit(1)",JSON.stringify(o),f.runtime);assert.equal(r.status,1);assert.match(r.stdout,/MEASURE_PASS/u)}finally{cleanup(f)}})
test('纯source validator拒绝候选漂移',()=>{const f=fixture();try{writeFileSync(join(f.root,'packages/bridge-core/src/source-001.ts'),'drift\n');const relative='packages/contracts/dist/generated.js';const r=pythonCall("\ntry:m.source_manifest(m.Path(sys.argv[2]),sys.argv[3],json.loads(sys.argv[4]))\nexcept m.IssueError as e:print(e);raise SystemExit(1)",f.root,f.head,JSON.stringify({[relative]:sha(join(f.root,relative))}));assert.equal(r.status,1);assert.match(r.stdout,/SOURCE_CANDIDATE/u)}finally{cleanup(f)}})
test('纯source validator只接受重建证明绑定的未跟踪contracts dist',()=>{const f=fixture();try{const relative='packages/contracts/dist/generated.js',digest=sha(join(f.root,relative));const r=pythonCall("value=m.source_manifest(m.Path(sys.argv[2]),sys.argv[3],json.loads(sys.argv[4]));print(json.dumps(value))",f.root,f.head,JSON.stringify({[relative]:digest}));assert.equal(r.status,0,r.stderr);const value=JSON.parse(r.stdout);assert.equal(Object.keys(value.files).length,241);assert.equal(value.files[relative],digest)}finally{cleanup(f)}})
test('下一authority必须精确继承prior queued issuer failure根及完整身份快照',()=>{const f=fixture();try{const prior=priorIssuerFailure(f),o=options(f);o.prior_issuer_failure=[prior.argv];const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));value=m.validate_prior_issuer_failures(o,m.Path(sys.argv[3]));print(json.dumps(value))",JSON.stringify(o),f.runtime);assert.equal(r.status,0,r.stderr);const value=JSON.parse(r.stdout);assert.equal(value.roots.length,1);assert.equal(value.facts[0].windowId,prior.windowId);assert.equal(value.roots[0].path,prior.parent);assert.equal(value.snapshots.length,1);assert.deepEqual(Object.keys(value.snapshots[0].files).sort(),['failure','issuerFact','owner','supervisor']);assert.equal(value.snapshots[0].issuerIdentity.path,join(prior.parent,'issuer-identity'))}finally{cleanup(f)}})
test('下一authority必须把已发布但pre-child失败的完整authority作为独立carryover根',()=>{const f=fixture();try{const prior=priorPrechildFailure(f),o=options(f);o.prior_prechild_failure=[prior.argv];const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));value=m.validate_prior_prechild_failures(o,m.Path(sys.argv[3]));print(json.dumps(value))",JSON.stringify(o),f.runtime);assert.equal(r.status,0,r.stderr);const value=JSON.parse(r.stdout);assert.equal(value.roots.length,1);assert.equal(value.facts[0].windowId,prior.windowId);assert.equal(value.roots[0].path,prior.parent);assert.deepEqual(Object.keys(value.facts[0].files).sort(),['failure','issuerFact','ownedManifest','owner','sourceManifest','supervisor','window'])}finally{cleanup(f)}})
test('下一authority必须把已终态PROCESS_EXIT完整目录作为独立carryover根',()=>{const f=fixture();try{const prior=priorProcessFailure(f),o=options(f);o.prior_process_failure=[prior.argv];const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));value=m.validate_prior_process_failures(o,m.Path(sys.argv[3]),json.loads(sys.argv[4]));print(json.dumps(value))",JSON.stringify(o),f.runtime,JSON.stringify(prior.historicalRoots));assert.equal(r.status,0,r.stderr);const value=JSON.parse(r.stdout);assert.equal(value.roots.length,1);assert.equal(value.facts[0].windowId,prior.windowId);assert.equal(value.roots[0].path,prior.parent);assert.deepEqual(Object.keys(value.facts[0].files).sort(),['close','issuerFact','ownedManifest','owner','sourceManifest','stderr','stdout','supervision','supervisor','supervisorStart','window']);assert.equal(value.facts[0].files.stderr.sha256,'0dfbd76c742fe7754a435fcb368a34dabe21adbdd23338ee9145ad5afb157298');assert.deepEqual(value.snapshots[0].supervision.entries,['stderr.log','stdout.log','supervisor-start.json','supervisor.json'])}finally{cleanup(f)}})

test('PROCESS_EXIT head压缩递归接受window05到window03并计费完整可达链',()=>{const f=fixture();try{const {leaf,head}=linkedProcessFailure(f);writeFileSync(head.stderr,'CAPACITY_PHASE_OPERATION_FAILED\n(node:97229) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n');const start=JSON.parse(readFileSync(head.supervisorStart));start.pid=97229;start.pgid=97229;put(head.supervisorStart,start);const supervision=JSON.parse(readFileSync(head.supervision));supervision.pid=97229;supervision.pgid=97229;put(head.supervision,supervision);const close=JSON.parse(readFileSync(head.close));close.pid=97229;close.pgid=97229;put(head.close,close);refreshProcessFailure(head);const o=options(f);o.prior_process_failure=[head.argv];const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));v=m.validate_prior_process_failures(o,m.Path(sys.argv[3]),json.loads(sys.argv[4]));print(json.dumps({'roots':[x['path'] for x in v['roots']],'billing':[x['path'] for x in v['billingRoots']],'snapshots':[x['windowId'] for x in v['snapshots']]}))",JSON.stringify(o),f.runtime,JSON.stringify(head.historicalRoots));assert.equal(r.status,0,r.stdout+r.stderr);const v=JSON.parse(r.stdout);assert.deepEqual(v.roots,[head.parent]);assert.deepEqual(v.billing.sort(),[leaf.parent,head.parent].sort());assert.deepEqual(v.snapshots,[head.windowId,leaf.windowId])}finally{cleanup(f)}})

test('PROCESS_EXIT head压缩拒绝nested row与owned[73]错配、reorder、fork/cycle及orphan',async t=>{for(const [name,mutate] of [
  ['nested row',({head})=>{const fact=JSON.parse(readFileSync(head.issuerFact));fact.processFailureCarryover[0].files.stderr.sha256='f'.repeat(64);put(head.issuerFact,fact);refreshProcessFailure(head)}],
  ['owned[73]',({head})=>{const owned=JSON.parse(readFileSync(head.owned));owned.roots[73]=structuredClone(owned.roots[0]);put(head.owned,owned);refreshProcessFailure(head)}],
  ['reorder',({head})=>{const owned=JSON.parse(readFileSync(head.owned));[owned.roots[0],owned.roots[1]]=[owned.roots[1],owned.roots[0]];put(head.owned,owned);refreshProcessFailure(head)}],
  ['fork',({head})=>{const fact=JSON.parse(readFileSync(head.issuerFact));fact.processFailureCarryover.push(structuredClone(fact.processFailureCarryover[0]));put(head.issuerFact,fact);refreshProcessFailure(head)}],
  ['cycle',({head})=>{const fact=JSON.parse(readFileSync(head.issuerFact));fact.processFailureCarryover=[processFailureFact(head)];put(head.issuerFact,fact);refreshProcessFailure(head)}],
  ['orphan',({f})=>{priorProcessFailure(f,'-orphan')}],
])await t.test(name,()=>{const f=fixture();try{const chain=linkedProcessFailure(f);mutate({...chain,f});const o=options(f);o.prior_process_failure=[chain.head.argv];const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));\ntry:m.validate_prior_process_failures(o,m.Path(sys.argv[3]),json.loads(sys.argv[4]))\nexcept m.IssueError as e:print(e);raise SystemExit(1)",JSON.stringify(o),f.runtime,JSON.stringify(chain.head.historicalRoots));assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/PRIOR_PROCESS_FAILURE|FILE_CHANGED/u)}finally{cleanup(f)}})})

test('PROCESS_EXIT carryover拒绝重哈希后前缀正确但正文漂移的stderr',()=>{const f=fixture();try{const prior=priorProcessFailure(f);writeFileSync(prior.stderr,'CAPACITY_PHASE_OPERATION_FAILED\n(node:314) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n');const stderrFact={path:prior.stderr,exists:true,size:statSync(prior.stderr).size,sha256:sha(prior.stderr)};const supervision=JSON.parse(readFileSync(prior.supervision));supervision.stderr=stderrFact;put(prior.supervision,supervision);const close=JSON.parse(readFileSync(prior.close));close.stderr=stderrFact;close.supervisorSha256=sha(prior.supervision);put(prior.close,close);prior.argv[1]=sha(prior.close);prior.argv[8]=sha(prior.supervision);prior.argv[11]=sha(prior.stderr);const o=options(f);o.prior_process_failure=[prior.argv];const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));\ntry:m.validate_prior_process_failures(o,m.Path(sys.argv[3]),json.loads(sys.argv[4]))\nexcept m.IssueError as e:print(e);raise SystemExit(1)",JSON.stringify(o),f.runtime,JSON.stringify(prior.historicalRoots));assert.equal(r.status,1,r.stderr);assert.match(r.stdout,/PRIOR_PROCESS_FAILURE/u)}finally{cleanup(f)}})

test('PROCESS_EXIT exact75稳定根及issuer/prechild仍逐项有序绑定',async t=>{for(const [name,mutate] of [['新增任意根',roots=>roots.push(structuredClone(roots[0]))],['marker替换',roots=>{roots[0].marker.sha256='f'.repeat(64)}],['issuer-prechild互换',roots=>{[roots[71],roots[72]]=[roots[72],roots[71]]}]])await t.test(name,()=>{const f=processRecoveryLineageFixture();try{const roots=structuredClone(f.currentRoots);mutate(roots);const r=validateProcessLineage(f,f.historicalMeasure,f.currentMappings,roots);assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/PRIOR_PROCESS_FAILURE_LINEAGE/u)}finally{f.cleanup()}})})
test('PROCESS_EXIT roots允许recovery-01到recovery-02有序谱系翻译并拒绝映射漂移',async t=>{await t.test('跨代正例',()=>{const f=processRecoveryLineageFixture();try{const r=validateProcessLineage(f);assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).translated,true)}finally{f.cleanup()}});for(const [name,mutate] of [['historicalRoot漂移',(f,m)=>{m[0].historicalRoot.inode+=1}],['映射重排',(f,m)=>{[m[0],m[1]]=[m[1],m[0]]}],['旧receipt漂移',(f,m,h)=>{rewriteDirectRecovery(f,r=>{r.repository.clean=false});h.measureRootRecovery.sha256=sha(f.receiptPath)}]])await t.test(name,()=>{const f=processRecoveryLineageFixture();try{const mappings=structuredClone(f.currentMappings),historical=structuredClone(f.historicalMeasure);mutate(f,mappings,historical);const r=validateProcessLineage(f,historical,mappings);assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/PRIOR_PROCESS_FAILURE_LINEAGE/u)}finally{f.cleanup()}})})
test('PROCESS_EXIT carryover自动审计runtime声明全集',()=>{const f=fixture();try{priorProcessFailure(f,'-a');const declared=priorProcessFailure(f,'-b'),o=options(f);o.prior_process_failure=[declared.argv];const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));\ntry:m.validate_prior_process_failures(o,m.Path(sys.argv[3]),json.loads(sys.argv[4]))\nexcept m.IssueError as e:print(e);raise SystemExit(1)",JSON.stringify(o),f.runtime,JSON.stringify(declared.historicalRoots));assert.equal(r.status,1);assert.match(r.stdout,/PRIOR_PROCESS_FAILURE_AUDIT/u)}finally{cleanup(f)}})
test('PROCESS_EXIT carryover拒绝重哈希后的终态schema漂移',()=>{const f=fixture();try{const prior=priorProcessFailure(f),close=JSON.parse(readFileSync(prior.close));close.queuedStop.sampleCount=1;put(prior.close,close);prior.argv[1]=sha(prior.close);const o=options(f);o.prior_process_failure=[prior.argv];const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));\ntry:m.validate_prior_process_failures(o,m.Path(sys.argv[3]),json.loads(sys.argv[4]))\nexcept m.IssueError as e:print(e);raise SystemExit(1)",JSON.stringify(o),f.runtime,JSON.stringify(prior.historicalRoots));assert.equal(r.status,1);assert.match(r.stdout,/PRIOR_PROCESS_FAILURE/u)}finally{cleanup(f)}})
test('PROCESS_EXIT carryover拒绝未声明目录项与日志字节漂移',async t=>{for(const [name,mutate] of [['目录项',prior=>writeFileSync(join(prior.parent,'extra'),'drift\n')],['stderr',prior=>writeFileSync(join(prior.parent,'supervision/stderr.log'),'drift\n')]])await t.test(name,()=>{const f=fixture();try{const prior=priorProcessFailure(f);mutate(prior);const o=options(f);o.prior_process_failure=[prior.argv];const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));\ntry:m.validate_prior_process_failures(o,m.Path(sys.argv[3]),json.loads(sys.argv[4]))\nexcept m.IssueError as e:print(e);raise SystemExit(1)",JSON.stringify(o),f.runtime,JSON.stringify(prior.historicalRoots));assert.equal(r.status,1);assert.match(r.stdout,/DIRECTORY_IDENTITY|FILE_CHANGED/u)}finally{cleanup(f)}})})
test('PROCESS_EXIT验证在UUID前执行、绑定facts并在发布前二次比对快照',()=>{const source=readFileSync(sourceIssuer,'utf8'),issue=source.slice(source.indexOf('def issue(options):'));const first=issue.indexOf('process_failures = validate_prior_process_failures('),firstLineage=issue.indexOf("process_failures['lineage'] = [validate_process_recovery_lineage("),uuid=issue.indexOf('window_id = str(uuid.uuid4())'),pending=issue.indexOf("pending = parent / 'window.pending.json'"),second=issue.indexOf('second_process_failures = validate_prior_process_failures('),secondLineage=issue.indexOf("second_process_failures['lineage'] = [validate_process_recovery_lineage("),publish=issue.indexOf("os.rename(pending, parent / 'window.json')");assert.ok(first>=0&&first<firstLineage&&firstLineage<uuid);assert.ok(second>pending&&second<secondLineage&&secondLineage<publish);assert.match(issue,/expected_process_inherited = \[\*measure\['roots'\], \*prior_failures\['roots'\],/u);assert.match(issue,/second_expected_process_inherited = \[\*second_measure\['roots'\], \*second_prior_failures\['roots'\],/u);assert.match(issue,/'processFailureCarryover': process_failures\['facts'\]/u);assert.match(issue,/second_process_failures\['billingRoots'\] != process_failures\['billingRoots'\]/u);assert.match(issue,/second_process_failures\['lineage'\] != process_failures\['lineage'\]/u);const roots=pythonCall("print(json.dumps([m.EXPECTED_PREFLIGHT_ROOTS,m.EXPECTED_AUTHORITY_ROOTS]))");assert.equal(roots.status,0,roots.stderr);assert.deepEqual(JSON.parse(roots.stdout),[74,76])})
test('pre-child carryover声明集合遗漏或终态收据漂移必须拒绝',()=>{
  const f=fixture()
  try {
    priorPrechildFailure(f,'-a')
    const declared=priorPrechildFailure(f,'-b'),o=options(f)
    o.prior_prechild_failure=[declared.argv]
    const omitted=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));\ntry:m.validate_prior_prechild_failures(o,m.Path(sys.argv[3]))\nexcept m.IssueError as e:print(e);raise SystemExit(1)",JSON.stringify(o),f.runtime)
    assert.equal(omitted.status,1)
    assert.match(omitted.stdout,/PRIOR_PRECHILD_FAILURE_AUDIT/u)
    const receipt=JSON.parse(readFileSync(declared.failure));receipt.sampleCount=1
    rmSync(declared.failure);put(declared.failure,receipt)
    const drifted=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));\ntry:m.validate_prior_prechild_failures(o,m.Path(sys.argv[3]))\nexcept m.IssueError as e:print(e);raise SystemExit(1)",JSON.stringify(o),f.runtime)
    assert.equal(drifted.status,1)
    assert.match(drifted.stdout,/HASH_MISMATCH/u)
  } finally { cleanup(f) }
})
test('声明集合遗漏runtime中的queued issuer failure必须拒绝',()=>{const f=fixture();try{priorIssuerFailure(f,'-a');const declared=priorIssuerFailure(f,'-b');const o=options(f);o.prior_issuer_failure=[declared.argv];const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));\ntry:m.validate_prior_issuer_failures(o,m.Path(sys.argv[3]))\nexcept m.IssueError as e:print(e);raise SystemExit(1)",JSON.stringify(o),f.runtime);assert.equal(r.status,1);assert.match(r.stdout,/PRIOR_ISSUER_FAILURE_AUDIT/u)}finally{cleanup(f)}})
test('later-stage queued issuer failure的source与owned文件也进入精确carryover',()=>{const f=fixture();try{const prior=priorIssuerFailure(f,'-late','owned'),o=options(f);o.prior_issuer_failure=[prior.argv];const r=pythonCall("o=types.SimpleNamespace(**json.loads(sys.argv[2]));value=m.validate_prior_issuer_failures(o,m.Path(sys.argv[3]));print(json.dumps(value))",JSON.stringify(o),f.runtime);assert.equal(r.status,0,r.stderr);const value=JSON.parse(r.stdout);assert.deepEqual(Object.keys(value.facts[0].files).sort(),['failure','issuerFact','ownedManifest','owner','sourceManifest','supervisor']);assert.equal(value.snapshots[0].root.entries.length,6)}finally{cleanup(f)}})
