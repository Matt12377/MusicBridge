import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {validateIpcRequest,isMBQueueRecord,MAX_MB_QUEUE_JSON_BYTES,mbQueueSerializedBytes} from '../../src/index.js';
test('007公开队列命令稳定entry/queue身份，Roon queue_id和未知私有字段不能代用',()=>{
 const queueId=randomUUID(),entryId=randomUUID(),payload={queueId,expectedRevision:'9007199254740993',entryId};
 assert.equal(validateIpcRequest({version:1,id:'queue',command:'playback.playQueueEntry',payload}).ok,true);
 for(const bad of [{...payload,queueId:'roon-native-queue-id'},{...payload,expectedRevision:9007199254740993},{...payload,url:'https://secret.invalid'},{...payload,session:'秘密'}])assert.equal(validateIpcRequest({version:1,id:'queue',command:'playback.playQueueEntry',payload:bad}).ok,false);
});
test('007持久记录闭合且UTF8总预算独立计字节，超预算不能截断为合法队列',()=>{
 const q={schemaVersion:'1.2',datasetId:randomUUID(),queueId:randomUUID(),revision:'1',currentEntryId:null,entries:[],restartPolicy:{reResolve:true,autoplay:false}};
 const oversized={...q,entries:[{entryId:randomUUID(),entryRevision:'1',quality:'auto',source:{kind:'netease',trackId:'𠮷'.repeat(MAX_MB_QUEUE_JSON_BYTES/4)}}]};
 assert.ok(mbQueueSerializedBytes(oversized)>MAX_MB_QUEUE_JSON_BYTES);assert.equal(isMBQueueRecord(oversized),false);
 assert.equal(isMBQueueRecord({...q,sourceRootPath:'/私有'}),false);assert.equal(isMBQueueRecord({...q,restartPolicy:{reResolve:true,autoplay:true}}),false);
});
