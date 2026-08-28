// 固定源码输入，只创建新的输出与工作目录；不覆盖既有构建，不使用 Homebrew 运行库。
import { mkdir, readFile, writeFile, copyFile, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ffmpegBuildPolicy, ffmpegConfigureArgs } from '../../packages/bridge-core/src/recording/ffmpeg-build-policy.ts';
import { loadBundledConverter } from '../../packages/bridge-core/src/recording/bundled-converter.ts';
const execute=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
const [archiveArg,outputArg,workArg,...extra]=process.argv.slice(2);
if(process.platform!=='darwin'||process.arch!=='arm64'||!archiveArg||!outputArg||!workArg||extra.length)throw new Error('用法：在 macOS arm64 上提供固定源码压缩包、新输出目录、新工作目录。');
const archive=await realpath(archiveArg),output=path.resolve(outputArg),work=path.resolve(workArg);
if(output===work||output.startsWith(work+path.sep)||work.startsWith(output+path.sep))throw new Error('输出和工作目录必须相互独立。');
if((await stat(archive)).size>32*1024*1024||hash(await readFile(archive))!==ffmpegBuildPolicy.source.sha256)throw new Error('源码 SHA-256 不符合已核定版本。');
await mkdir(work);await mkdir(output);for(const dir of ['bin','lib','legal'])await mkdir(path.join(output,dir));
const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C',MACOSX_DEPLOYMENT_TARGET:'13.0'};
async function run(label,command,args,cwd=work){
  try{const r=await execute(command,args,{cwd,env,timeout:15*60_000,maxBuffer:32*1024*1024});await writeFile(path.join(work,label+'.log'),r.stdout+r.stderr);return r.stdout;}
  catch(e){await writeFile(path.join(work,label+'.log'),String(e.stdout??'')+String(e.stderr??''));throw new Error(label+' 失败；日志保留在工作目录。');}
}
await run('extract','/usr/bin/tar',['-xJf',archive,'-C',work]);
const source=path.join(work,'ffmpeg-8.1.2'),build=path.join(work,'build'),stage=path.join(work,'stage');await mkdir(build);
const args=ffmpegConfigureArgs();await run('configure',path.join(source,'configure'),args,build);
const config=await readFile(path.join(build,'config.h'),'utf8');
for(const flag of ['GPL','NONFREE','VERSION3','NETWORK'])if(!config.includes('#define CONFIG_'+flag+' 0'))throw new Error('构建许可或网络开关不符合策略。');
await run('make','/usr/bin/make',['-j4'],build);await run('install','/usr/bin/make',['install','DESTDIR='+stage],build);
const installed=path.join(stage,'MusicBridgeFFmpeg'),names=['bin/ffmpeg','bin/ffprobe',...ffmpegBuildPolicy.libraries.map(l=>'lib/'+l.id)];
const allowedSystem=new Set(['/usr/lib/libSystem.B.dylib','/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation','/System/Library/Frameworks/CoreVideo.framework/Versions/A/CoreVideo','/System/Library/Frameworks/CoreMedia.framework/Versions/A/CoreMedia']);
const allowedLibraries=new Set(ffmpegBuildPolicy.libraries.map(l=>'@rpath/'+l.id)),files=[];
for(const relative of names){
  const file=path.join(output,relative);await copyFile(path.join(installed,relative),file);
  await run('sign-'+path.basename(file),'/usr/bin/codesign',['--force','--sign','-','--timestamp=none',file]);
  await run('signature-'+path.basename(file),'/usr/bin/codesign',['--verify','--strict',file]);
  if((await run('arch-'+path.basename(file),'/usr/bin/lipo',['-archs',file])).trim()!=='arm64')throw new Error('存在非 arm64 产物。');
  const linked=await run('links-'+path.basename(file),'/usr/bin/otool',['-L',file]);
  const dependencies=linked.split('\n').slice(1).map(line=>line.trim().split(' (')[0]).filter(Boolean);
  if(dependencies.some(dep=>!allowedLibraries.has(dep)&&!allowedSystem.has(dep)))throw new Error('出现未核定的动态依赖。');
  const load=await run('load-'+path.basename(file),'/usr/bin/otool',['-l',file]);
  const rpaths=[...load.matchAll(/cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.+?) \(offset/g)].map(m=>m[1]);
  if(rpaths.some(p=>p!=='@executable_path/../lib'))throw new Error('出现未核定的动态库查找目录。');
  files.push({relative,sha256:hash(await readFile(file)),dependencies});
}
const programs={};for(const name of ['ffmpeg','ffprobe']){
  const version=await run('version-'+name,path.join(output,'bin',name),['-version']);
  if(!version.startsWith(name+' version 8.1.2 ')||!version.includes('--disable-gpl')||version.includes('--enable-gpl')||version.includes('--enable-nonfree'))throw new Error('实际程序版本或配置不符合策略。');
  programs[name]={path:'bin/'+name,sha256:files.find(f=>f.relative==='bin/'+name).sha256,versionSha256:hash(version)};
}
const protocols=await run('protocols',path.join(output,'bin/ffmpeg'),['-hide_banner','-protocols']);
if(protocols.split('\n').map(l=>l.trim()).filter(l=>l&&!['Supported file protocols:','Input:','Output:','fd'].includes(l)).length)throw new Error('程序暴露了非 FD 协议。');
await run('license',path.join(output,'bin/ffmpeg'),['-L']);
const manifest={schemaVersion:1,platform:'darwin',arch:'arm64',minimumMacOS:'13.0',sourceSha256:ffmpegBuildPolicy.source.sha256,license:'LGPL-2.1-or-later',build:{version:'8.1.2',...programs,dependencies:ffmpegBuildPolicy.libraries.map(l=>({id:l.id,path:'lib/'+l.id,sha256:files.find(f=>f.relative==='lib/'+l.id).sha256})),components:ffmpegBuildPolicy.libraries.map(l=>({name:l.name,version:l.version}))}};
await copyFile(archive,path.join(output,'legal/ffmpeg-8.1.2.tar.xz'));
for(const name of ['COPYING.LGPLv2.1','LICENSE.md'])await copyFile(path.join(source,name),path.join(output,'legal',name));
await writeFile(path.join(output,'legal/BUILD.json'),JSON.stringify({source:ffmpegBuildPolicy.source,configure:args,sourceChanges:'none',signing:'ad-hoc-local-candidate-not-release',linkage:files},null,2)+'\n');
await writeFile(path.join(output,'legal/NOTICE.txt'),'本软件使用 FFmpeg 8.1.2，按 LGPL 2.1 或更高版本许可。\nThis software uses FFmpeg under LGPL version 2.1 or later.\nCopyright (c) the FFmpeg developers. https://ffmpeg.org/\n对应完整源码、许可证和构建选项随本目录提供；应用通过独立子进程使用共享库构建。\n本地候选为 ad-hoc 签名；不代表分发法律审查、Developer ID 或公证通过。\n');
const bytes=JSON.stringify(manifest,null,2)+'\n';await writeFile(path.join(output,'manifest.json'),bytes,{flag:'wx'});
await loadBundledConverter(await realpath(output),hash(bytes));
await writeFile(path.join(work,'result.json'),JSON.stringify({manifestSha256:hash(bytes),files,sourceSha256:ffmpegBuildPolicy.source.sha256},null,2)+'\n');
console.log(JSON.stringify({manifestSha256:hash(bytes),files:files.length,sourceSha256:ffmpegBuildPolicy.source.sha256,releaseReady:false}));
