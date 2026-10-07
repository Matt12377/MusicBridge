import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isCommonsArtworkSource, isLocalArtworkCommandPayload, isLocalArtworkContext, isLocalArtworkQuery, isLocalArtworkTarget } from '../src/local-artwork.js';
import { validateIpcInternalRequest, validateIpcRequest } from '../src/validator.js';

const id=randomUUID(),target={trackId:id,editionId:id,expectedEditionRevision:'1',expectedTrackRevision:'1',expectedSourceRevision:'a'.repeat(64)};
const image={original:{mime:'image/jpeg',bytes:5,sha256:'b'.repeat(64),width:1,height:1},display:{mime:'image/jpeg',bytes:5,sha256:'b'.repeat(64),width:1,height:1,dataUrl:'data:image/jpeg;base64,/9gA/9k='}};
const source={pageId:123,pageRevision:456,fileSha1:'c'.repeat(40),fileTimestamp:'2026-10-07T00:00:00Z',title:'File:用户作品.jpg',author:'合成作者',descriptionUrl:'https://commons.wikimedia.org/wiki/File:%E7%94%A8%E6%88%B7%E4%BD%9C%E5%93%81.jpg',licenseUrl:'https://creativecommons.org/publicdomain/zero/1.0/',policyVersion:'2026-10-07-cc0-only-v1'};
const stage={target,origin:'manual',sourceIdentity:'d'.repeat(64),sourceLabel:'合成图片',image};
test('封面公开请求需要工作库与完整修订，可信候选命令不能从公开通道进入',()=>{
  const request={version:1,id,command:'localArtwork.stage',payload:stage,expectedDatasetId:id};
  assert.equal(validateIpcRequest(request).ok,false);assert.equal(validateIpcInternalRequest(request).ok,true);
  assert.equal(validateIpcRequest({version:1,id,command:'localArtwork.apply',expectedDatasetId:id,payload:{commandId:id,target,candidateId:null,expectedSelectionRevision:null}}).ok,true);
  assert.equal(validateIpcRequest({version:1,id,command:'localArtwork.context',payload:{trackId:id,editionId:null}}).ok,false);
});
test('隐藏路径、getter、symbol和个人照片/Frozen用途不能混入数字发行目标',()=>{
  let invoked=0;
  for(const bad of [{...target,purpose:'personal-photo'},{...target,path:'/私有'},Object.defineProperty({...target},'url',{value:'http://127.0.0.1'}),{...target,[Symbol('私有')]:1},Object.defineProperty({...target},'trackId',{enumerable:true,get(){invoked++;return id;}})]) assert.equal(isLocalArtworkTarget(bad),false);
  assert.equal(invoked,0);
});
test('逐文件CC0来源是可信Main闭集，许可或来源不能由泛用URL替代',()=>{
  assert.equal(isCommonsArtworkSource(source),true);
  for(const bad of [{...source,licenseUrl:'https://example.test/cc0'},{...source,descriptionUrl:'https://127.0.0.1/File:a.jpg'},{...source,descriptionUrl:'https://commons.wikimedia.org/wiki/File:a.jpg?url=http://localhost'},{...source,policyVersion:'任意版本'},{...source,fileSha1:'1'}]) assert.equal(isCommonsArtworkSource(bad),false);
  assert.equal(isLocalArtworkCommandPayload('localArtwork.stage',{...stage,origin:'provider',remoteSource:source}),true);
  assert.equal(isLocalArtworkCommandPayload('localArtwork.stage',{...stage,origin:'provider'}),false);
  assert.equal(isLocalArtworkCommandPayload('localArtwork.stage',{...stage,remoteSource:source}),false);
});
test('公开上下文拒绝稀疏候选、索引getter和不属于目标的候选',()=>{
  const context={trackId:id,trackRevision:'1',target,editions:[{id,title:'独立发行',edition:'',revision:'1'}],selection:null,candidates:[],remoteProvider:'commons-cc0-v1',sourceFilesWrite:'OFF',status:'missing'};
  assert.equal(isLocalArtworkContext(context),true);assert.equal(isLocalArtworkContext({...context,candidates:new Array(1)}),false);
  let invoked=0;const index=Object.defineProperty([],'0',{enumerable:true,get(){invoked++;return {};}});assert.equal(isLocalArtworkContext({...context,candidates:index}),false);assert.equal(invoked,0);
});
test('搜索仅接受有界字面关键词，原图Hash不能成为发行或质量请求',()=>{
  assert.equal(isLocalArtworkQuery('天空 唱片'),true);for(const q of ['', ' 空格 ', 'a'.repeat(81),'http://127.0.0.1/a','曲\n目'])assert.equal(isLocalArtworkQuery(q),false);
  assert.equal(isLocalArtworkCommandPayload('localArtwork.createEdition',{commandId:id,trackId:id,expectedTrackRevision:'1',title:'同名发行'}),true);
  assert.equal(isLocalArtworkCommandPayload('localArtwork.createEdition',{commandId:id,trackId:id,expectedTrackRevision:'1',title:'同名发行',imageHash:'a'.repeat(64)}),false);
});
