import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAlbumName, cleanTrackTitle, resolveAlbumNameCandidates, nameEvidence, inferAlbumBoundaries, discoverAlbumDirectoryCandidates, classifyDirectoryName } from '../../src/library/local-name-rules.js';

test('清洗前保留原文与版本，标题语义不误删', () => {
  const raw = ' 1989 [首版] [FLAC] ';
  const result = nameEvidence(raw, 'album');
  assert.equal(result.raw, raw);
  assert.equal(result.display, '1989');
  assert.ok(result.versionTokens.some(token => token.raw === '首版'));
  assert.ok(result.versionTokens.some(token => token.raw === 'FLAC'));
  for (const title of ['1989', '24K Magic', '演唱会', '混音', 'Live at Wembley', 'Remix']) assert.equal(cleanTrackTitle(title), title);
  assert.equal(cleanAlbumName('24K Magic', undefined), '24K Magic');
});
test('完整专辑覆盖率独立于有效标签一致性', () => {
  const result = resolveAlbumNameCandidates({ artistName: '艺人', albumName: '未知专辑', aiMode: 'off', members: Array.from({ length: 20 }, (_, i) => ({ trackId: `t${i}`, ...(i === 0 ? { album: '好专辑' } : {}) })) });
  assert.equal(result.candidates[0]?.coverage, 0.05);
  assert.equal(result.candidates[0]?.consistency, 1);
  assert.equal(result.candidates[0]?.confidence, 'low');
  assert.equal(result.album.display, '未知专辑');
});
test('并列候选必须确认，关闭AI保持独立', () => {
  const input = { artistName: '艺人', albumName: '专辑', aiMode: 'off' as const, members: [{ trackId: 'a', album: '甲' }, { trackId: 'b', album: '乙' }] };
  const result = resolveAlbumNameCandidates(input);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every(candidate => candidate.confidence === 'ambiguous' && candidate.needsConfirmation));
  assert.deepEqual(resolveAlbumNameCandidates(input), result);
});
test('人工覆盖优先，候选键相同也不合并曲目或版本', () => {
  const members = [{ trackId: 'original', album: '专辑 [首版]' }, { trackId: 'remaster', album: '专辑 [Remastered]' }];
  const result = resolveAlbumNameCandidates({ artistName: '艺人', albumName: '专辑', members, manual: { artistName: '人工歌手', albumName: '人工专辑 [首版]', boundaryId: 'manual-edition' }, aiMode: 'off' });
  assert.equal(result.artist.display, '人工歌手');
  assert.equal(result.album.raw, '人工专辑 [首版]');
  assert.deepEqual(result.members, members);
  assert.equal(result.manual?.boundaryId, 'manual-edition');
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0]?.supportingTrackIds, ['original', 'remaster']);
  assert.equal(result.members.length, 2);
});
test('CD子目录归属原专辑，人工边界在重新计算后保留', () => {
  const facts = [{ id: 'artist', parentId: null, name: '艺人', directAudioCount: 0 }, { id: 'album', parentId: 'artist', name: '专辑', directAudioCount: 0 }, { id: 'cd1', parentId: 'album', name: 'CD1', directAudioCount: 10 }, { id: 'cd2', parentId: 'album', name: 'CD2', directAudioCount: 10 }];
  assert.deepEqual(inferAlbumBoundaries(facts, 'artist').map(x => x.boundaryId), ['album', 'album']);
  assert.equal(inferAlbumBoundaries(facts, 'artist', [{ directoryId: 'cd1', boundaryId: 'handmade' }])[0]?.boundaryId, 'handmade');
});
test('年份与现场混音语义并存时不能删年份或语义', () => {
  for (const value of ['1989 [Live]', '1989 [Remix]', '银色月光下(演唱会)', '专辑 (混音版)', '专辑 (Live Version)']) assert.equal(cleanAlbumName(value), value);
});
test('所有展示删除的技术格式在raw token中保留', () => {
  for (const specification of ['1bit 2.8224MHz', '[FLAC24bit48Khz]', '[SACDISO]', '1644', '[LPCD45]', '96 24', '[24bit96kHz]', '[24bit192kHz]', '[２４ｂｉｔ１９２ｋＨｚ]']) {
    const raw = `专辑 ${specification}`, result = nameEvidence(raw, 'album');
    assert.equal(result.display, '专辑');
    assert.ok(result.versionTokens.some(token => token.kind === 'format'), raw);
    for (const token of result.versionTokens) assert.equal(raw.slice(token.start, token.end), token.raw);
  }
  for (const specification of ['[首批]', '[银圈]', '[銀圈]', '香港银圈', '[百代珍藏套装之7]']) {
    const raw = `专辑 ${specification}`, result = nameEvidence(raw, 'album');
    assert.equal(result.display, '专辑');
    assert.ok(result.versionTokens.some(token => token.kind === 'edition'), raw);
    for (const token of result.versionTokens) assert.equal(raw.slice(token.start, token.end), token.raw);
  }
});
test('纯噪声、短子串与未佐证多数标签均不能自动替换目录名', () => {
  for (const [folder, tag] of [['真实专辑 [WAV]', 'WAV'], ['Dark Side of the Moon', 'a'], ['Original Album', 'Wrong Album']]) {
    const result = resolveAlbumNameCandidates({ artistName: '歌手', albumName: folder!, members: Array.from({ length: 10 }, (_, i) => ({ trackId: `t${i}`, album: tag! })), aiMode: 'off' });
    assert.equal(result.album.display, cleanAlbumName(folder!));
    assert.ok(result.candidates.every(candidate => candidate.needsConfirmation));
  }
});
test('可信候选替换展示时原目录与全部标签版本证据仍保留', () => {
  const result = resolveAlbumNameCandidates({ artistName: 'SHE合集【qobuz】', albumName: '2005-I...Do [首版]', members: [{ trackId: 'stable', artist: 'S.H.E', album: 'I DO [Remastered]' }], aiMode: 'off' });
  assert.equal(result.album.display, 'I DO'); assert.equal(result.rawNames.albumName, '2005-I...Do [首版]');
  assert.ok(result.rawVersionTokens.some(token => token.raw === '首版'));
  assert.equal(result.memberEvidence[0]?.album?.raw, 'I DO [Remastered]');
  assert.ok(result.memberEvidence[0]?.album?.versionTokens.some(token => token.raw === 'Remastered'));
});
test('占位和纯格式不是有效标签，同时计入完整专辑覆盖缺口', () => {
  const result = resolveAlbumNameCandidates({ artistName: '歌手', albumName: '真实专辑', members: [{ trackId: 'one', album: '真实专辑' }, { trackId: 'placeholder', album: 'CDImage' }, { trackId: 'format', album: 'WAV' }, { trackId: 'missing' }], aiMode: 'off' });
  const candidate = result.candidates[0]!;
  assert.equal(candidate.validTagCount, 1); assert.equal(candidate.totalTrackCount, 4);
  assert.equal(candidate.consistency, 1); assert.equal(candidate.coverage, 0.25); assert.equal(candidate.confidence, 'low');
});
test('有限繁简表之外的字符保留，NFKC候选等价不改变身份', () => {
  const raw = '體驗 [首版]', evidence = nameEvidence(raw, 'album');
  assert.equal(evidence.raw, raw); assert.equal(evidence.display, '體驗');
  const members = [{ trackId: 'unchanged-width', album: 'ＡＣ／ＤＣ' }, { trackId: 'unchanged-ascii', album: 'AC/DC' }];
  const result = resolveAlbumNameCandidates({ artistName: '歌手', albumName: 'AC/DC', members, aiMode: 'off' });
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0]?.canonicalKey, 'acdc');
  assert.deepEqual(result.members, members); assert.equal(result.memberEvidence[0]?.album?.raw, 'ＡＣ／ＤＣ');
});
test('格式前缀必须有完整技术后缀，普通专辑名不能合到父目录', () => {
  for (const value of ['Waves', 'Aperitif', 'FlacDream']) assert.equal(classifyDirectoryName(value), 'ordinary');
  for (const value of ['WAV', 'WAV24bit96kHz', 'FLAC24-192', 'DSD64']) assert.equal(classifyDirectoryName(value), 'format');
  const result = discoverAlbumDirectoryCandidates({ role: 'artist', root: 'Artist',
    audioPaths: ['Artist/Box/Waves/01.flac', 'Artist/Box/Waves/02.flac', 'Artist/Box/Aperitif/01.flac', 'Artist/Box/Aperitif/02.flac'], cuePaths: [] });
  assert.deepEqual(result.albums.map(album => album.albumName).sort(), ['Aperitif', 'Waves']);
  assert.ok(result.albums.every(album => album.relativeAudioPaths.length === 2 && album.boundaryPath !== 'Artist/Box'));
});
test('有限多歌手目录分组隔离，交错输入保持每个歌手的CD和版本边界', () => {
  const result = discoverAlbumDirectoryCandidates({ role: 'library', root: '库', audioPaths: [
    '库/歌手甲/同名专辑/CD1/01.wav', '库/歌手乙/同名专辑/港版/01.wav',
    '库/歌手甲/同名专辑/CD2/01.wav', '库/歌手乙/同名专辑/日本版/01.wav', '库/歌手丙/散曲.wav', '库/根目录散曲.wav',
  ], cuePaths: [] });
  assert.equal(result.albums.length, 3);
  const first = result.albums.find(album => album.artistName === '歌手甲')!;
  assert.equal(first.boundaryPath, '库/歌手甲/同名专辑'); assert.deepEqual(first.relativeAudioPaths, ['CD1/01.wav', 'CD2/01.wav']);
  const versions = result.albums.filter(album => album.artistName === '歌手乙');
  assert.equal(versions.length, 2); assert.ok(versions.every(album => album.issues.some(issue => issue.type === 'uncertainAlbumBoundary')));
  assert.deepEqual(result.looseAudioPaths, ['库/根目录散曲.wav', '库/歌手丙/散曲.wav']);
});
