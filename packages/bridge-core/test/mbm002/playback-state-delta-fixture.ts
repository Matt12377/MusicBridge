import { playbackCopy, playbackResourceContext, playbackReadyFacts, type PlaybackState, type StoredPlaybackReceipt } from '../../src/mobile/playback-state.js';
import { type PlaybackStoragePatch } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, type MobilePlaybackStateCodecContext } from '../../src/mobile/playback-types.js';
import { CAPACITY_SERVER as SERVER,CAPACITY_DATASET as DATASET,CAPACITY_ORIGIN as ORIGIN,CAPACITY_NOW as NOW,capacityDigest } from './playback-state-capacity-fixture.js';

export const deltaContext=(state:PlaybackState):MobilePlaybackStateCodecContext=>({serverId:SERVER,datasetId:DATASET,responseOrigin:ORIGIN,
  generation:'delta.synthetic.1',revision:state.revision,commitId:state.commitId,limits:MOBILE_PLAYBACK_DEFAULT_LIMITS});
type ResourcePatch=Extract<PlaybackStoragePatch,{kind:'createResource'|'publishResource'}>;
export function deltaCreate(base:PlaybackState,n=1):ResourcePatch{
  const resource=playbackCopy(base.resources[0]!),parent=base.sessions.find(row=>row.id===resource.sessionId)!;
  resource.id=`delta.resource.${n}`;resource.state='preparing';resource.failure=null;resource.source=null;resource.media=null;resource.tickets=[];
  resource.createdAt=NOW;resource.lastActivityAt=NOW;resource.expiresAt=Math.min(NOW+300000,parent.expiresAt);resource.hardExpiresAt=resource.expiresAt;
  const receipt=playbackCopy(base.receipts.find(row=>row.operation==='createResource'&&row.sessionId===parent.id)!) as StoredPlaybackReceipt;
  receipt.id=`delta.receipt.${n}`;receipt.resourceId=resource.id;receipt.createdAt=NOW;receipt.state='UNKNOWN';receipt.reply=null;receipt.resourceContext=null;
  receipt.request.idempotencyKey=`delta.original-key.${n}`;receipt.request.body=playbackCopy(resource.request);
  receipt.keyHash=capacityDigest('key',[receipt.deviceId,receipt.deviceEpoch,receipt.request.idempotencyKey]);
  receipt.fingerprint=capacityDigest('request',[receipt.scopeHash,receipt.request.body]);
  return{kind:'createResource',clockFloor:NOW,resource,receipt};
}
export function deltaPublish(base:PlaybackState,n=1,preparing=false):ResourcePatch{
  const resource=playbackCopy(base.resources.find(row=>row.id===`delta.resource.${n}`)!),receipt=playbackCopy(base.receipts.find(row=>row.id===`delta.receipt.${n}`)!);
  const template=base.resources.find(row=>row.source!==null)!,parent=base.sessions.find(row=>row.id===resource.sessionId)!;
  resource.source=playbackCopy(template.source)!;resource.state=preparing?'preparing':'ready';
  if(!playbackReadyFacts(resource.source))throw Error('合成ready来源事实不完整');
  const identity={id:resource.id,sessionId:resource.sessionId,trackId:resource.request.trackId,versionId:resource.request.versionId,contentRevision:resource.request.contentRevision,
    sourceAudio:playbackCopy(resource.source.sourceAudio),processing:playbackCopy(resource.source.processing)};
  if(!preparing){resource.media={url:`${ORIGIN}/mobile/v1/media/${resource.id}/source?ticket=${'a'.repeat(64)}`,
    transport:'file',expiresAt:new Date(resource.expiresAt).toISOString(),durationMs:resource.source.durationMs,seekable:resource.source.seekable,actualAudio:playbackCopy(resource.source.actualAudio)};
    resource.tickets=[{hash:'b'.repeat(64),expiresAt:resource.expiresAt,runtimeEpoch:resource.runtimeEpoch}];}
  if(receipt.state==='UNKNOWN'){receipt.state='RECORDED';receipt.reply={status:preparing?202:201,body:preparing?{...identity,state:'preparing',retryAfterMs:100}:{...identity,state:'ready',media:playbackCopy(resource.media)!}};
    receipt.resourceContext=playbackResourceContext(SERVER,ORIGIN,parent,resource,NOW);}
  return{kind:'publishResource',clockFloor:NOW,resource,receipt};
}
export function deltaCandidate(base:PlaybackState,patch:PlaybackStoragePatch,serial:number):PlaybackState{
  const candidate=playbackCopy(base);candidate.revision++;candidate.commitId=`delta.commit.${serial}`;candidate.clockFloor=patch.clockFloor;
  if(patch.kind==='createSession'){candidate.sessions.push(playbackCopy(patch.session));candidate.receipts.push(playbackCopy(patch.receipt));}
  else if(patch.kind==='createResource'){candidate.resources.push(playbackCopy(patch.resource));candidate.receipts.push(playbackCopy(patch.receipt));}
  else{candidate.resources=candidate.resources.map(row=>row.id===patch.resource.id?playbackCopy(patch.resource):row);candidate.receipts=candidate.receipts.map(row=>row.id===patch.receipt.id?playbackCopy(patch.receipt):row);}
  return candidate;
}

export function deltaSession(base:PlaybackState,n=1):Extract<PlaybackStoragePatch,{kind:'createSession'}>{
  const session=playbackCopy(base.sessions[0]!);session.id=`delta.session.${n}`;session.clientInstanceId=`delta.client.${n}`;
  session.createdAt=NOW;session.expiresAt=NOW+1800000;session.terminal=null;session.lastSequence=0;session.playerGeneration=null;
  session.currentQueueItemId=null;session.currentResourceId=null;session.observation=null;
  const receipt=playbackCopy(base.receipts.find(row=>row.operation==='createSession')!);receipt.id=`delta.session.receipt.${n}`;receipt.sessionId=session.id;receipt.createdAt=NOW;
  receipt.request.idempotencyKey=`delta.session.key.${n}`;receipt.request.body={clientInstanceId:session.clientInstanceId};
  receipt.keyHash=capacityDigest('key',[receipt.deviceId,receipt.deviceEpoch,receipt.request.idempotencyKey]);receipt.fingerprint=capacityDigest('request',[receipt.scopeHash,receipt.request.body]);
  receipt.reply={status:201,body:{id:session.id,deviceId:session.deviceId,createdAt:new Date(session.createdAt).toISOString(),expiresAt:new Date(session.expiresAt).toISOString()}};
  return{kind:'createSession',clockFloor:NOW,session,receipt};
}
