import assert from 'node:assert/strict';
import test from 'node:test';
import { mobileDataSnapshot } from '@music-bridge/contracts';
import { captureMobileNeteaseDirectorySongSnapshot, captureMobileNeteaseSongSnapshot } from '../../src/netease/mobile-source-snapshot.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const song = () => ({ id: '1', name: '合成曲目', ar: [{ id: '3', name: '合成艺人' }], al: { id: '2', name: '合成专辑' }, dt: 1500 });
const binding = () => ({ account: { accountDomain: 'account-1', providerEpoch: 'epoch-1' },
  selection: { trackId: 'nt:1', source: 'netease' as const, versionId: 'nv:1', contentRevision: 'nr:1' },
  sourceItemId: '1', albumId: 'na:2', providerAlbumId: '2', editionLabel: '',
  media: { md5: 'a'.repeat(32), size: 150000 }, availability: 'available' as const });
const safe = (value: unknown) => { const result = mobileDataSnapshot(value); assert.ok(result.ok); return result.value; };
const rejects = (work: () => unknown) => assert.throws(work, (error: unknown) => error instanceof MobileServiceError && error.code === 'SOURCE_CHANGED');

test('目录构造只保留已确认metadata和授权描述符，不声称已读取音频头', () => {
  const value = captureMobileNeteaseDirectorySongSnapshot(song(), binding());
  assert.deepEqual(safe(value.track.audio), safe({ codec: 'unknown', container: 'unknown' }));
  assert.equal(value.track.durationMs, 1500); assert.equal(value.track.availability, 'available');
  assert.equal(value.track.sourceItemId, '1'); assert.equal(value.track.albumId, 'na:2');
  assert.ok(Object.isFrozen(value.track) && Object.isFrozen(value.track.audio) && Object.isFrozen(value.track.artists));
  assert.doesNotMatch(JSON.stringify(value), /md5|headerSha256|upstreamUrl|sampleRateHz|bitsPerSample/u);
});

test('明确不可用目录条目不取得媒体描述符，available不能借null或畸形媒体通过', () => {
  const unavailable = captureMobileNeteaseDirectorySongSnapshot(song(), { ...binding(), media: null, availability: 'unavailable' });
  assert.equal(unavailable.track.availability, 'unavailable');
  rejects(() => captureMobileNeteaseDirectorySongSnapshot(song(), { ...binding(), media: null }));
  rejects(() => captureMobileNeteaseDirectorySongSnapshot(song(), { ...binding(), availability: 'unavailable' }));
  for (const media of [{ md5: 'bad', size: 150000 }, { md5: 'a'.repeat(32), size: 0 },
    { md5: 'a'.repeat(32), size: Number.MAX_SAFE_INTEGER + 1 }])
    rejects(() => captureMobileNeteaseDirectorySongSnapshot(song(), { ...binding(), media }));
});

test('目录构造继续拒绝身份错配、损坏metadata、Proxy和所用getter', () => {
  rejects(() => captureMobileNeteaseDirectorySongSnapshot(song(), { ...binding(), sourceItemId: '9' }));
  rejects(() => captureMobileNeteaseDirectorySongSnapshot(song(), { ...binding(), providerAlbumId: '9' }));
  for (const raw of [{ ...song(), ar: [] }, { ...song(), dt: 0 }, { ...song(), name: '\u0000坏标题' },
    { ...song(), id: Number.MAX_SAFE_INTEGER + 1 }, new Proxy(song(), {})])
    rejects(() => captureMobileNeteaseDirectorySongSnapshot(raw, binding()));
  let touched = false; const getter = { ...song() };
  Object.defineProperty(getter, 'name', { enumerable: true, get() { touched = true; return '不可读取'; } });
  rejects(() => captureMobileNeteaseDirectorySongSnapshot(getter, binding())); assert.equal(touched, false);
});

test('实际观察构造仍强制真实规格和文件头，不接受目录unknown事实替代', () => {
  const observed = { audio: { codec: 'flac', container: 'flac', sampleRateHz: 192000, bitsPerSample: 24, channels: 2 },
    size: 150000, durationMs: 1000, contentType: 'audio/flac' as const, headerSha256: 'b'.repeat(64) };
  const { media: _media, ...base } = binding();
  const value = captureMobileNeteaseSongSnapshot(song(), { ...base, observed });
  assert.equal(value.track.audio.sampleRateHz, 192000); assert.equal(value.track.audio.bitsPerSample, 24); assert.equal(value.track.durationMs, 1000);
  rejects(() => captureMobileNeteaseSongSnapshot(song(), { ...base, observed: { ...observed, audio: { codec: 'unknown', container: 'unknown' } } }));
  rejects(() => captureMobileNeteaseSongSnapshot(song(), { ...base, observed: { ...observed, headerSha256: '' } }));
});
