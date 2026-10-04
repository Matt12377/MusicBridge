import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { LOCAL_CATALOG_COMMANDS, LOCAL_CATALOG_INTERNAL_COMMANDS, LOCAL_CATALOG_OUTBOX_COMMANDS, validateIpcRequest, validateIpcInternalRequest, isCommandOutboxExecute, isLocalCatalogCommandResult, type LocalCatalogCommandPayloads } from '../../src/index.js';
const id = randomUUID(), scope = randomUUID();
const payloads: LocalCatalogCommandPayloads = {
  'localCatalog.registerRoot': {commandId:id,sourceRootId:id,role:'library'},
  'localCatalog.relinkRoot': {commandId:id,sourceRootId:id,role:'library',rootId:id,expectedRevision:'1'},
  'localCatalog.registerAsset': {commandId:id,libraryRootId:id,expectedRootRevision:'1',relative:'合成/一.flac',sha256:null,sampleFrames:'96000',timebaseHz:48000},
  'localCatalog.moveAsset': {commandId:id,assetId:id,expectedLocationRevision:'1',expectedRootRevision:'1',relative:'合成/二.flac'},
  'localCatalog.replaceAsset': {commandId:id,libraryRootId:id,expectedRootRevision:'1',relative:'合成/二.flac',sha256:'a'.repeat(64),sampleFrames:'96000',timebaseHz:48000,assetId:id,expectedFileRevision:'1',expectedLocationRevision:'1'},
  'localCatalog.createTrack': {commandId:id,assetId:id,segment:null},
  'localCatalog.selectAsset': {commandId:id,trackId:id,expectedSelectionRevision:'1',assetId:id},
  'localCatalog.createEdition': {commandId:id,title:'合成专辑',edition:''},
  'localCatalog.linkEditionTrack': {commandId:id,editionId:id,trackId:id,disc:1,trackNumber:1,sequence:1},
  'localCatalog.removeEditionTrack': {commandId:id,id,expectedRevision:'1'},
  'localCatalog.observeMetadata': {commandId:id,trackId:id,source:'synthetic',parserVersion:'fixture-1',fields:{title:'原始'}},
  'localCatalog.overrideMetadata': {commandId:id,trackId:id,expectedRevision:null,fields:{title:'人工'}},
  'localCatalog.root': {rootId:id},'localCatalog.roots': {},'localCatalog.asset': {assetId:id},'localCatalog.track': {trackId:id},
  'localCatalog.pageTracks': {offset:0,limit:200},'localCatalog.edition': {editionId:id},'localCatalog.editionTracks': {editionId:id},
  'localCatalog.observations': {trackId:id},'localCatalog.metadata': {trackId:id},'localCatalog.receipt': {commandId:id,operation:'create-track',fingerprint:'a'.repeat(64)},
};
const request = (command: keyof LocalCatalogCommandPayloads, payload: unknown = payloads[command]) => ({version:1,id,command,payload,expectedDatasetId:scope});
test('MBRS002 B2合同：22命令有闭集叶校验且全部要求原库scope', () => {
  assert.equal(LOCAL_CATALOG_COMMANDS.length,22);
  for (const command of LOCAL_CATALOG_COMMANDS) {
    assert.equal(validateIpcInternalRequest(request(command)).ok,true,command);
    assert.equal(validateIpcInternalRequest({...request(command),expectedDatasetId:undefined}).ok,false,command);
    assert.equal(validateIpcInternalRequest({...request(command),expectedDatasetId:'随意'}).ok,false,command);
    assert.equal(validateIpcInternalRequest({...request(command),trusted:true}).ok,false,command);
    assert.equal(validateIpcInternalRequest(request(command,{...payloads[command],surplus:true})).ok,false,command);
  }
  assert.equal(validateIpcRequest({...request('localCatalog.roots'),command:'localCatalog.eraseAll'}).ok,false);
});
test('MBRS002 B2合同：六个可信观察被普通validator及outbox实际入口拒绝', () => {
  assert.equal(LOCAL_CATALOG_INTERNAL_COMMANDS.length,6);
  for (const command of LOCAL_CATALOG_INTERNAL_COMMANDS) {
    assert.equal(validateIpcRequest(request(command)).ok,false,command);
    assert.equal(validateIpcInternalRequest(request(command)).ok,true,command);
    assert.equal(isCommandOutboxExecute({datasetId:scope,command,payload:payloads[command]}),false,command);
  }
  for (const command of LOCAL_CATALOG_OUTBOX_COMMANDS) assert.equal(isCommandOutboxExecute({datasetId:scope,command,payload:payloads[command]}),true,command);
});
test('MBRS002 B2合同：普通逻辑请求拒定位能力与代际字段，片段保留精确帧闭集', () => {
  for (const command of LOCAL_CATALOG_OUTBOX_COMMANDS) for (const key of ['relative','absolutePath','path','dev','ino','signature','generation','attempt','session','url','backend']) {
    const payload = {...payloads[command],[key]:'私有观察'};
    assert.equal(validateIpcRequest(request(command,payload)).ok,false,`${command}:${key}`);
    assert.equal(isCommandOutboxExecute({datasetId:scope,command,payload}),false);
  }
  const segment = {startFrame:'9007199254740993',endFrameExclusive:'9007199254740994',timebaseHz:48000};
  assert.equal(validateIpcRequest(request('localCatalog.createTrack',{...payloads['localCatalog.createTrack'],segment})).ok,true);
  for (const v of [{...segment,startFrame:9007199254740992},{...segment,startFrame:'01'},{...segment,endFrameExclusive:segment.startFrame},{...segment,id}]) assert.equal(validateIpcRequest(request('localCatalog.createTrack',{...payloads['localCatalog.createTrack'],segment:v})).ok,false);
});
test('MBRS002 B2合同：内部定位不可逃逸，公开结果拒路径和无关联的人工有效元数据', () => {
  for (const relative of ['/根/文件','../文件','a/../文件','a\\文件','a://文件','a//文件']) assert.equal(validateIpcInternalRequest(request('localCatalog.registerAsset',{...payloads['localCatalog.registerAsset'],relative})).ok,false);
  const track = {id,assetId:id,selectionRevision:'1',segment:null};
  assert.equal(isLocalCatalogCommandResult('localCatalog.track',track),true);
  assert.equal(isLocalCatalogCommandResult('localCatalog.track',{...track,relative:'私有'}),false);
  const view = {raw:{title:'原始'},override:{trackId:id,revision:'1',fields:{title:'人工'}},effective:{title:'人工'}};
  assert.equal(isLocalCatalogCommandResult('localCatalog.metadata',view),true);
  assert.equal(isLocalCatalogCommandResult('localCatalog.metadata',{...view,effective:{title:'伪造'}}),false);
});
