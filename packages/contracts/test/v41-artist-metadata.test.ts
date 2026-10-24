import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalMetadata, mergeLocalMetadata, isLocalPlayRequest, isLocalSearchPlayContext } from '../src/index.js';

test('metadata兼容旧字段，并接受明确结构化歌曲/专辑艺人', () => {
  assert.ok(isLocalMetadata({ artist: 'AC/DC', album: 'Back in Black' }));
  assert.ok(isLocalMetadata({ artist: '周杰伦', artists: ['周杰伦', '王菲'], albumArtist: 'Various Artists', albumArtists: ['Various Artists'] }));
  assert.ok(isLocalMetadata({ artists: [], albumArtists: [] }));
  assert.equal(isLocalMetadata({ artists: ['同名', '同名'] }), false);
  assert.equal(isLocalMetadata({ artists: Array(65).fill('艺人') }), false);
  assert.equal(isLocalMetadata({ artists: ['https://private.invalid'] }), false);
  assert.deepEqual(mergeLocalMetadata({ artist: '旧值', artists: ['旧值'], albumArtists: ['发行艺人'] }, { artist: '人工名称' }), { artist: '人工名称', albumArtists: ['发行艺人'] });
});
test('搜索播放context只选择原Owner上下文，和album互斥且不接收前端成员', () => {
  const context = { kind: 'search', query: 'zhou jie', revision: 'revision-1' };
  assert.ok(isLocalSearchPlayContext(context));
  assert.equal(isLocalSearchPlayContext({ ...context, trackIds: ['伪造成员'] }), false);
  const base = { schema_version: '1.2', request_id: 'request-1', route: 'roon_audio_input', source_kind: 'local_file', local_track_id: 'track', asset_id: 'asset', expected_asset_revision: '1', target: { core_id: 'core', zone_id: 'zone' }, action: 'PLAY_NOW' };
  assert.ok(isLocalPlayRequest({ ...base, context }));
  assert.equal(isLocalPlayRequest({ ...base, context, action: 'APPEND_MB_QUEUE' }), false);
  assert.equal(isLocalPlayRequest({ ...base, context, album: {} }), false);
});
