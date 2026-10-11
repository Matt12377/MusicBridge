import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  V39_INTEGRATION_TASK, V39_INTEGRATION_BRANCH, V39_INTEGRATION_SOURCE_PARENT, V39_INTEGRATION_REPOSITORY,
  V39_INTEGRATION_REPOSITORY_ID, V39_INTEGRATION_WORKFLOWS, v39IntegrationHasAuthority,
  inspectV39IntegrationWorkflowGuard, inspectV39IntegrationReportAdmission,
  validateV39IntegrationParentCi, v39IntegrationCanonicalPin, v39IntegrationProducerIdentity, v39IntegrationAdmittedSourceCi,
} from './v39-integration-admission.mjs';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const equal=(a,b)=>JSON.stringify(v39IntegrationCanonicalPin(a))===JSON.stringify(v39IntegrationCanonicalPin(b));
const positive=value=>Number.isSafeInteger(value)&&value>0;
/** Source与非法Report零API；当前Report成功后仅核公共producer，不下载产品或操作用户服务。 */
export async function inspectV39IntegrationReportOnly(env=process.env,directory=repository,getJson) {
  const full=reason=>({mode:'full',reason,task:V39_INTEGRATION_TASK,productResultsReused:false});
  let candidate=env.GITHUB_REF_NAME===V39_INTEGRATION_BRANCH||v39IntegrationHasAuthority(directory);
  const deadline=performance.now()+90000,budget={deadline};
  try{
    const outputs=inspectV39IntegrationWorkflowGuard(directory,env,budget);
    if(outputs.integrationMode==='not-applicable')return null;
    candidate=true;
    if(outputs.integrationRole==='source')return full('V39_CURRENT_SOURCE_REQUIRES_FRESH_PRODUCT_SOFTWARE');
    const report=inspectV39IntegrationReportAdmission(directory,env,budget);
    if(env.GITHUB_ACTIONS!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.GITHUB_EVENT_NAME!=='push'
      ||env.GITHUB_API_URL!=='https://api.github.com'||env.GITHUB_REPOSITORY!==V39_INTEGRATION_REPOSITORY
      ||env.GITHUB_SHA!==report.headAtAdmission)return full('V39_NOT_PUBLIC_HOSTED_PUSH_CONTEXT');
    const readApi=getJson??(async endpoint=>{
      const remaining=deadline-performance.now();if(remaining<=0)throw new Error('CI_API_BUDGET');
      const response=await fetch('https://api.github.com/repos/'+V39_INTEGRATION_REPOSITORY+endpoint,{
        headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
        signal:AbortSignal.timeout(Math.min(15000,Math.ceil(remaining)))});
      if(!response.ok)throw new Error('CI_API_UNAVAILABLE');
      const reader=response.body.getReader(),chunks=[];let bytes=0;
      try{while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.length;
        if(bytes>2097152)throw new Error('CI_API_OVERFLOW');chunks.push(Buffer.from(item.value));}}
      finally{await reader.cancel();}
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    });
    const api=async endpoint=>{
      const remaining=Math.min(15000,deadline-performance.now());if(remaining<=0)throw new Error('CI_API_BUDGET');
      let timer;
      try{
        const result=await Promise.race([readApi(endpoint),new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('CI_API_BUDGET')),Math.ceil(remaining));})]);
        if(performance.now()>=deadline||Buffer.byteLength(JSON.stringify(result),'utf8')>2097152)throw new Error('CI_API_BUDGET');
        return result;
      }finally{clearTimeout(timer);}
    };
    const repo=await api('');
    if(repo?.id!==V39_INTEGRATION_REPOSITORY_ID||repo.full_name!==V39_INTEGRATION_REPOSITORY||repo.private!==false)
      return full('V39_REPOSITORY_IDENTITY_UNKNOWN');
    const listing=await api('/actions/runs?head_sha='+report.sourceSha+'&event=push&per_page=100');
    if(listing?.total_count!==4||!Array.isArray(listing.workflow_runs)||listing.workflow_runs.length!==4)
      return full('V39_PARENT_RUN_LIST_NOT_EXACT');
    const runs=listing.workflow_runs,proofs=[];
    for(const file of V39_INTEGRATION_WORKFLOWS){
      const selected=runs.filter(run=>run?.path===file);if(selected.length!==1||!positive(selected[0].id))
        return full('V39_PARENT_RUN_LIST_NOT_EXACT');
      const run=selected[0],jobs=await api('/actions/runs/'+run.id+'/attempts/1/jobs?per_page=100'),
        artifacts=await api('/actions/runs/'+run.id+'/artifacts?per_page=100');
      if(!Array.isArray(jobs?.jobs)||jobs.total_count!==jobs.jobs.length||!Array.isArray(artifacts?.artifacts)
        ||artifacts.total_count!==artifacts.artifacts.length)return full('V39_PARENT_LIST_INCOMPLETE');
      proofs.push({runId:run.id,jobs:jobs.jobs,artifacts:artifacts.artifacts});
    }
    if(!validateV39IntegrationParentCi({task:V39_INTEGRATION_TASK,repositoryId:V39_INTEGRATION_REPOSITORY_ID,
      parent:report.sourceSha,branch:V39_INTEGRATION_BRANCH,runs,proofs}))return full('V39_PARENT_CURRENT_PRODUCT_CI_NOT_PROVEN');
    if(!equal(v39IntegrationProducerIdentity({runs,proofs}),v39IntegrationProducerIdentity(v39IntegrationAdmittedSourceCi(report))))
      return full('V39_PARENT_PRODUCERS_CHANGED');
    const repeated=inspectV39IntegrationReportAdmission(directory,env,budget);
    if(!equal(repeated,report))return full('V39_REPORT_CHANGED_DURING_API');
    return {schema:'musicbridge.report-only-ci.v1',mode:'report-only',reason:'EXACT_PARENT_CURRENT_PRODUCT_CI_SUCCESS',
      task:V39_INTEGRATION_TASK,reportSha:report.headAtAdmission,parentSourceSha:report.sourceSha,
      sourceParentSha:V39_INTEGRATION_SOURCE_PARENT,scopeSha256:report.scopeSha256,repositoryId:V39_INTEGRATION_REPOSITORY_ID,
      productResultsReused:true,currentProductTestsRepeated:false,artifactContentDownloaded:false,
      evidenceScope:'PUBLIC_CURRENT_SOURCE_PRODUCT_PRODUCERS_WITH_PREVIOUS_WHOLE_CONTENT_RECEIPT',
      workflows:proofs.map(proof=>({runId:proof.runId,jobIds:proof.jobs.map(job=>job.id),
        artifacts:proof.artifacts.map(({id,name,digest,expired})=>({id,name,digest,expired}))}))};
  }catch{return candidate?full('V39_IDENTITY_OR_API_REJECTED'):null;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  inspectV39IntegrationReportOnly().then(result=>{
    if(process.argv.length!==2||!result)throw new Error('V39_REPORT_ROUTE_REQUIRED');
    const output={mode:result.mode,reason:result.reason,task:result.task};
    if(process.env.GITHUB_OUTPUT)writeFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(output).map(([key,value])=>key+'='+value+'\n').join(''),{flag:'a'});
    process.stdout.write(JSON.stringify(result)+'\n');
    if(result.mode!=='report-only')process.exitCode=1;
  }).catch(()=>{process.stderr.write('V3.9 Tape报告CI精确准入失败。\n');process.exitCode=1;});
}
