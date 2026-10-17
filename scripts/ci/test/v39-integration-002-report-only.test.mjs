import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash,randomBytes } from 'node:crypto';
import path from 'node:path';
import * as authority from '../v39-integration-002-admission.mjs';
import { inspectV39Integration002ReportOnly } from '../report-only-v39-integration-002.mjs';
import { fixtureEnvironment,fixtureGit,sourceFixture,sourceCiFixture,reportFixture,writeFixture,toolFixture,fakeArtifact,recordsOfArtifact } from './v39-integration-002-admission.test.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
let shared;
const report=()=>shared??=reportFixture();
const envFor=f=>({...fixtureEnvironment,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_EVENT_NAME:'push',GITHUB_API_URL:'https://api.github.com',
 GITHUB_REPOSITORY:authority.V39_INTEGRATION_REPOSITORY,GITHUB_SHA:f.report,GITHUB_REF_NAME:authority.V39_INTEGRATION_BRANCH});
function publicApi(ci){return async endpoint=>{if(endpoint==='')return {id:authority.V39_INTEGRATION_REPOSITORY_ID,full_name:authority.V39_INTEGRATION_REPOSITORY,private:false};
 if(endpoint.startsWith('/actions/runs?'))return {total_count:4,workflow_runs:ci.runs};
 const id=Number(/\/runs\/(\d+)/u.exec(endpoint)?.[1]),proof=ci.proofs.find(row=>row.runId===id);assert.ok(proof);
 return endpoint.includes('/jobs?')?{total_count:proof.jobs.length,jobs:proof.jobs}:{total_count:proof.artifacts.length,artifacts:proof.artifacts};};}
function changedReport(change){const f=reportFixture(),original=f.report;change(f.directory);fixtureGit(f.directory,['add','-A']);fixtureGit(f.directory,['commit','--allow-empty','-m','CONTROLLED_FAKE_ONLY: report mutation']);
 assert.notEqual(fixtureGit(f.directory,['rev-parse','HEAD']),original);return f.directory;}
function reject(directory){assert.throws(()=>authority.inspectV39Integration002ReportAdmission(directory,fixtureEnvironment),error=>/^V39_002_/u.test(error.code??''));}
function replaceReceiptFile(ci,name,change){const artifact=ci.artifacts.find(row=>row.name==='verify-'+ci.revision),records=recordsOfArtifact(artifact),record=records.find(row=>row.path===name);
 const value=JSON.parse(record.bytes);change(value);record.bytes=Buffer.from(JSON.stringify(value)+'\n');
 const roots=records.filter(row=>authority.v39Integration002ToolRootNames('source').includes(row.path)),rebuilt=fakeArtifact(records,{id:artifact.id,name:artifact.name,profile:'verify-source',source:ci.revision,
  toolContent:authority.encodeV39Integration002ToolContent(roots,'source'),auxiliaryContents:artifact.auxiliaryContents});
 delete rebuilt.controlledWholeZipBytes;ci.artifacts[ci.artifacts.indexOf(artifact)]=rebuilt;
 const metadata=ci.proofs.flatMap(row=>row.artifacts).find(row=>row.id===artifact.id);metadata.size_in_bytes=rebuilt.zip.bytes;metadata.digest='sha256:'+rebuilt.zip.sha256;return ci;}
const run=(index,body)=>test(authority.V39_INTEGRATION_REPORT_CASE_NAMES[index],async()=>{await new Promise(resolve=>setImmediate(resolve));await body();});
run(0,()=>{const f=report(),r=authority.inspectV39Integration002ReportAdmission(f.directory,fixtureEnvironment);assert.equal(r.headAtAdmission,f.report);assert.equal(r.sourceSha,f.source);
 assert.equal(r.exactReportFiles,8);assert.equal(authority.v39Integration002WorkflowOutputs(r).productVerificationMode,'exact-parent-current-product-reuse');});
run(1,()=>{reject(changedReport(d=>writeFixture(d,'unlisted-report.md','不可第9叶\n')));const f=report();assert.throws(()=>authority.inspectV39Integration002ReportAdmission(f.directory,{...fixtureEnvironment,GITHUB_SHA:f.source}));});
run(2,()=>{reject(changedReport(d=>writeFixture(d,authority.V39_INTEGRATION_SCOPE_PATH,'{}\n')));reject(changedReport(d=>writeFixture(d,authority.V39_INTEGRATION_DONOR_PATH,'{}\n')));});
run(3,()=>{const f=report(),state=JSON.parse(readFileSync(path.join(f.directory,authority.V39_INTEGRATION_STATUS_PATH))),identity=JSON.parse(readFileSync(path.join(f.directory,authority.V39_INTEGRATION_CI_EVIDENCE_PATH)));
 assert.deepEqual(state.sourceEvidenceCanonical,authority.v39IntegrationCanonicalPin(identity));assert.ok(!JSON.stringify(state).includes('notifications_url'));
 reject(changedReport(d=>{const file=authority.V39_INTEGRATION_STATUS_PATH,state=JSON.parse(readFileSync(path.join(d,file)));state.sourceEvidenceCanonical.sha256='0'.repeat(64);writeFixture(d,file,JSON.stringify(state)+'\n');}));});
run(4,()=>{reject(changedReport(d=>{const file='project/STATUS.json',raw=readFileSync(path.join(d,file),'utf8'),match=/"mtimeNs": (\d{16,})/u.exec(raw);assert.ok(match);
 const before=BigInt(match[1]),after=before+1n;assert.equal(Number(before),Number(after));writeFixture(d,file,raw.slice(0,match.index)+match[0].replace(match[1],String(after))+raw.slice(match.index+match[0].length));}));});
run(5,()=>{const ci=sourceCiFixture();for(const change of [x=>x.status='FAILED',x=>x.artifacts[0].allMembersBytesAndCrcRead=false,x=>x.artifacts.pop(),
 x=>x.proofs[3].jobs[0].conclusion='failure',x=>x.artifacts[0].auxiliaryContents=[]]){const bad=structuredClone(ci);change(bad);assert.equal(authority.validateV39Integration002SourceReceipt(bad,bad.revision),false);}});
run(6,async()=>{let calls=0;const f=sourceFixture(),full=await inspectV39Integration002ReportOnly({...envFor(report()),GITHUB_SHA:f.source},f.directory,async()=>{calls++;throw new Error('Source不能调用API');});
 assert.equal(full.mode,'full');assert.equal(calls,0);const d=changedReport(directory=>writeFixture(directory,'unexpected.txt','零API'));const denied=await inspectV39Integration002ReportOnly(envFor(report()),d,async()=>{calls++;throw new Error('非法Report不能调用API');});assert.equal(denied.mode,'full');assert.equal(calls,0);
 const fixture=report(),result=await inspectV39Integration002ReportOnly(envFor(fixture),fixture.directory,publicApi(fixture.ci));assert.equal(result.mode,'report-only');assert.equal(result.artifactContentDownloaded,false);});
run(7,async()=>{const f=report(),api=publicApi(f.ci),result=await inspectV39Integration002ReportOnly(envFor(f),f.directory,api);assert.equal(result.workflows.length,4);
 const wrong=structuredClone(f.ci);wrong.runs=wrong.runs.slice(0,2);assert.equal(authority.validateV39Integration002ParentCi({task:wrong.task,repositoryId:wrong.repositoryId,parent:wrong.revision,branch:wrong.branch,runs:wrong.runs,proofs:wrong.proofs,now:Date.now()}),false);});
run(8,()=>{const f=sourceFixture(),tool=toolFixture(f.source);const decoded=authority.decodeV39Integration002ToolContent(tool.toolContent);for(const row of tool.records)assert.deepEqual(decoded.rootRecords.get(row.path),row.bytes);
 for(const change of [x=>x.rootArchive.gzip.base64+='=',x=>x.rootArchive.entries[0].crc32^=1,x=>x.rootArchive.rawBytes++,x=>x.rootArchive.gzip.base64='!AAA']){const bad=structuredClone(tool.toolContent);change(bad);assert.throws(()=>authority.decodeV39Integration002ToolContent(bad));}});
run(9,()=>{const f=sourceFixture(),tool=toolFixture(f.source),row=tool.records.find(row=>row.path==='boundaries.stdout.log');row.bytes=randomBytes(5*1024*1024).toString('base64');row.bytes=Buffer.from(row.bytes);
 const large=authority.encodeV39Integration002ToolContent(tool.records,'source'),round=authority.decodeV39Integration002ToolContent(large);assert.deepEqual(round.rootRecords.get(row.path),row.bytes);
 row.bytes=Buffer.alloc(16777217);assert.throws(()=>authority.encodeV39Integration002ToolContent(tool.records,'source'));});
run(10,()=>{for(const field of ['timedOut','overflow','cleanupFailed','rawForcedClosed','descendantScanFailed','unexpectedPipeHolder']){
 const ci=replaceReceiptFile(sourceCiFixture(),'summary.json',summary=>{summary.stages[0][field]=true;});assert.equal(authority.validateV39Integration002SourceReceipt(ci,ci.revision),false);}
 const ci=replaceReceiptFile(sourceCiFixture(),'summary.json',summary=>{summary.stages[0].physicalShutdown.pidAbsent=false;});assert.equal(authority.validateV39Integration002SourceReceipt(ci,ci.revision),false);});
run(11,()=>{const f=report(),status=JSON.parse(readFileSync(path.join(f.directory,authority.V39_INTEGRATION_STATUS_PATH)));assert.equal(status.ownerAcceptance,'NOT_RUN');assert.equal(status.realApplicationServiceDeviceAudio,'NOT_RUN');
 const plan=JSON.parse(readFileSync(path.join(f.directory,'project/POSTRUST_PLAN.json')));assert.equal(plan.effective_scope.originalAcceptanceCases,156);assert.equal(plan.effective_scope.activeAcceptanceCases,150);
 reject(changedReport(d=>{const file=authority.V39_INTEGRATION_STATUS_PATH,state=JSON.parse(readFileSync(path.join(d,file)));state.ownerAcceptance='PASS';writeFixture(d,file,JSON.stringify(state)+'\n');}));});
