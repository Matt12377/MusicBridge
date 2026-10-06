/** Root-only构建镜像准备；不安装、不构建、不加载产品，无自动回写。 */
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildStoragePolicy } from '../../apps/desktop/scripts/build-storage-root.mjs';

const fail = () => { throw new Error('构建镜像未准入；保留已有目录供Root检查，不重试或覆盖。'); };
const options = new Map();
for (let i=2; i<process.argv.length; i+=2) {
  const key=process.argv[i],value=process.argv[i+1];
  if (!['--source','--destination','--expected-head'].includes(key) || options.has(key) || !value) fail();
  options.set(key,value);
}
if (options.size!==3) fail();
const source=options.get('--source'),destination=options.get('--destination'),expectedHead=options.get('--expected-head');
if (![source,destination].every(p=>path.isAbsolute(p)&&path.resolve(p)===p&&!/[\r\n\0]/u.test(p)) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(expectedHead)) fail();
if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink() || realpathSync(source)!==source) fail();
if (destination===source || destination.startsWith(source+path.sep) || source.startsWith(destination+path.sep)) fail();
const storage=buildStoragePolicy(),root=path.dirname(destination);
storage.check(root);storage.check(destination);
if (existsSync(destination) || lstatSync(destination,{throwIfNoEntry:false})) fail();
const deadline=performance.now()+120_000;
const check=()=>{if(performance.now()>=deadline)fail();};
// Git只访问本地明确source；不读取、复制或打印remote URL/credential config。
const gitEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
Object.assign(gitEnv,{GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
const git=(args,allowOne=false)=>{
  check();const remaining=Math.floor(deadline-performance.now());if(remaining<=0)fail();
  const result=spawnSync('git',args,{env:gitEnv,encoding:'utf8',timeout:remaining,maxBuffer:1024*1024});check();
  if(result.error||result.signal!==null||!(result.status===0||allowOne&&result.status===1))fail();
  return {text:result.stdout.trim(),status:result.status};
};
const identity=p=>{
  const top=git(['-C',p,'rev-parse','--show-toplevel']).text;
  const head=git(['-C',p,'rev-parse','HEAD']).text;
  const tree=git(['-C',p,'rev-parse','HEAD^{tree}']).text;
  // 所有未跟踪/修改均硬拒，绝不盲拷dirty WIP或用户本地文件。
  if(top!==p || git(['-C',p,'status','--porcelain=v1','--untracked-files=all']).text!=='')fail();
  const branch=git(['-C',p,'symbolic-ref','--quiet','HEAD'],true);
  if(branch.status===0&&!branch.text.startsWith('refs/heads/'))fail();
  return {head,tree,branch:branch.status===0?branch.text:null};
};
const before=identity(source);if(before.head!==expectedHead)fail();
check();mkdirSync(root,{recursive:true,mode:0o700});check();storage.check(root,{mustExist:true});
// --no-local不复制source .git/config；--no-hardlinks不把Git对象写入身份与source共享。
git(['-c','protocol.file.allow=always','clone','--no-local','--no-hardlinks','--no-checkout','--',source,destination]);
storage.check(destination,{mustExist:true});
if(before.branch===null)git(['-C',destination,'checkout','--detach',before.head,'--']);
else git(['-C',destination,'checkout','-B',before.branch.slice('refs/heads/'.length),before.head,'--']);
const mirror=identity(destination),after=identity(source);
if(JSON.stringify(after)!==JSON.stringify(before)||JSON.stringify(mirror)!==JSON.stringify(before))fail();
if(existsSync(path.join(destination,'node_modules')))fail();
check();
const cache=path.join(root,'cache'),tmp=path.join(root,'tmp');
for(const p of [cache,tmp]){storage.check(p);mkdirSync(p,{recursive:true,mode:0o700});check();storage.check(p,{mustExist:true});}
const environment={
  MUSIC_BRIDGE_BUILD_WORKSPACE:destination,TMPDIR:tmp,DEV_BUILD_ROOT:root,DEV_CACHE_ROOT:cache,
  COREPACK_HOME:path.join(cache,'corepack'),npm_config_cache:path.join(cache,'npm'),
  npm_config_store_dir:path.join(cache,'pnpm'),XDG_CACHE_HOME:cache,
  ELECTRON_CACHE:path.join(cache,'Electron'),electron_config_cache:path.join(cache,'Electron'),
  CARGO_HOME:path.join(cache,'cargo'),RUSTUP_HOME:path.join(cache,'rustup'),
};
const receipt={schema:'musicbridge.build-workspace-mirror.v1',status:'SOURCE_PINNED_CLEAN_GIT_MIRROR_PREPARED',source,destination,sourceIdentity:before,mirrorIdentity:mirror,environment,
  productLoaded:false,installExecuted:false,buildExecuted:false,testsExecuted:false,ownToolClosure:'PENDING_ROOT_TOOL_CLOSURE'};
const receiptPath=path.join(root,'BUILD_WORKSPACE_MIRROR_PREPARATION.json');storage.check(receiptPath,{kind:'file'});
writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});check();
if(process.env.GITHUB_ACTIONS==='true'){
  if(!process.env.GITHUB_ENV||!path.isAbsolute(process.env.GITHUB_ENV))fail();
  // GitHub命令文件由runner提供；这里只发布无凭据、无用户数据的固定目录值。
  appendFileSync(process.env.GITHUB_ENV,Object.entries(environment).map(([k,v])=>`${k}=${v}\n`).join(''));check();
}
console.log(JSON.stringify({status:receipt.status,receipt:receiptPath,workspace:destination,sourceHead:before.head,ownToolClosure:receipt.ownToolClosure}));
