import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateLocalPlaybackCompatibility, isLocalPlaybackObservationLeaf } from '../../src/local-playback-compat.js';
const leaf = {"schema_version": "1.2", "request_id": "synthetic-request", "attempt_id": "synthetic-attempt", "intent_generation": "9007199254740993", "route": "roon_audio_input", "local_track_id": "synthetic-local", "asset_id": "synthetic-asset", "asset_revision": "1", "target": {"core_id": "synthetic-core", "zone_id": "synthetic-zone"}, "session_epoch": null, "phase": "PREPARING", "ownership": "MB_PENDING", "queue_owner": "NONE", "delivery_state": "NOT_STARTED", "roon_observation": {"event": "NONE", "observed": false, "correlation": "UNKNOWN"}, "position_ms": null, "quality": {"http_bytes": "NOT_TESTED", "signal_path": "NOT_TESTED", "digital_output": "NOT_TESTED", "gapless": "NOT_TESTED"}, "error_code": null};
test('MBRS002 B4合同：legacy与compact-v1仅旧来源可兼容，local显式unsupported不产生投影', () => {
  for (const protocol of ['legacy','compact-v1']) {
    for (const source of ['roon','netease']) assert.deepEqual(evaluateLocalPlaybackCompatibility(protocol,source),{supported:true,protocol,source});
    assert.deepEqual(evaluateLocalPlaybackCompatibility(protocol,'local_file'),{supported:false,code:'LOCAL_PLAYBACK_PROTOCOL_UNSUPPORTED'});
  }
  assert.equal(evaluateLocalPlaybackCompatibility('local-v2','local_file').supported,false);
  assert.equal(evaluateLocalPlaybackCompatibility('compact-v1','smart').supported,false);
});
test('MBRS002 B4合同：local叶unknown position保留null，旧事件不注册新叶', () => {
  assert.equal(isLocalPlaybackObservationLeaf(leaf),true); assert.equal(leaf.position_ms,null);
  for (const position_ms of [0, Number.MAX_SAFE_INTEGER]) assert.equal(isLocalPlaybackObservationLeaf({...leaf,position_ms}),true);
  for (const position_ms of [-1, 0.5, Number.MAX_SAFE_INTEGER+1, '0', undefined]) assert.equal(isLocalPlaybackObservationLeaf({...leaf,position_ms}),false);
  for (const key of ['url','path','backend','session_handle']) assert.equal(isLocalPlaybackObservationLeaf({...leaf,[key]:'SYNTHETIC_FORBIDDEN'}),false);
});
test('MBRS002 B4合同：HTTP BYTES_SENT不认证Playing，合成confirmed形状不等原Controller真实性', () => {
  const http = {...leaf,delivery_state:'BYTES_SENT'};
  assert.equal(isLocalPlaybackObservationLeaf(http),true); assert.equal(http.phase,'PREPARING');
  assert.equal(isLocalPlaybackObservationLeaf({...http,phase:'PLAYING'}),false);
  const shaped = {...http,phase:'PLAYING',ownership:'MB_OWNED',session_epoch:'synthetic-opaque-epoch',roon_observation:{event:'PLAYING',observed:true,correlation:'ATTEMPT_CONFIRMED'}};
  assert.equal(isLocalPlaybackObservationLeaf(shaped),true);
  for (const roon_observation of [{...shaped.roon_observation,observed:false},{...shaped.roon_observation,correlation:'PARTIAL'},{...shaped.roon_observation,event:'NONE'}]) assert.equal(isLocalPlaybackObservationLeaf({...shaped,roon_observation}),false);
  // 此case只检查叶结构与相关性一致，不证明真实回调、授权来源或代际创建。
});
