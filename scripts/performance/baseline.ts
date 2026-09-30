import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { PageRequest, PlaybackSnapshot, RoonLibraryItem, RoonLibraryPage, TrackSummary, TypedIpcEvent } from '../../packages/contracts/src/index.js';
import type { MusicBridgePublicApi } from '../../apps/desktop/src/preload/api.js';
import { usePlaybackSession } from '../../apps/desktop/src/renderer/src/composables/application/usePlaybackSession.js';
import { favoriteDescriptorForRoonItem } from '../../apps/desktop/src/renderer/src/composables/playbackFavorites.js';
import { collectRoonPlaybackContext } from '../../apps/desktop/src/renderer/src/roon-context-queue.js';
import { createPlaybackEventPublisher } from '../../packages/bridge-core/src/application/playback-event-publisher.js';
import { createRoonLibraryService, type RoonBrowseApi } from '../../packages/bridge-core/src/roon/library.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXTERNAL_ROOT = '/Volumes/LifeWeave';
const measuredFiles = [
  'apps/desktop/src/renderer/src/composables/application/usePlaybackSession.ts',
  'apps/desktop/src/renderer/src/roon-context-queue.ts',
  'packages/bridge-core/src/roon/library.ts',
  'packages/bridge-core/src/application/playback-event-publisher.ts',
] as const;

const nextTurn = (): Promise<void> => new Promise((done) => setImmediate(done));
function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>((done) => { complete = done; });
  return { promise, complete };
}

function syntheticTrack(index: number): TrackSummary {
  return { id: String(index + 1), title: `合成曲目${index + 1}`, artists: ['合成艺人'], album: '合成专辑' };
}

function syntheticRoonItem(index: number): RoonLibraryItem {
  return {
    reference: `musicbridge-v2-entity-00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
    kind: 'track', title: index === 2 ? '合成重复曲' : `合成曲目${index + 1}`,
    artist: '合成艺人', album: '合成专辑', discNumber: index < 125 ? 1 : 2,
    trackNumber: index % 125 + 1,
  };
}

function playbackSnapshot(size: number, positionMs = 0): PlaybackSnapshot {
  const tracks = Array.from({ length: size }, (_, index) => syntheticTrack(index));
  return {
    state: 'playing', source: 'netease', positionMs, currentTrack: tracks[0]!,
    queue: { items: tracks.map((track) => ({ trackId: track.id, track, qualityPreference: 'auto', resolvedSource: 'netease' })), index: 0, hasNext: size > 1, hasPrevious: false },
    canNext: size > 1, canPrevious: false, canStop: true, canPause: true, canResume: false,
  };
}

/** 闸住第一个剩余页，直接观察真实 Renderer 播放入口是否已经派发。 */
export async function rendererPlaybackScenario(total = 250, limit = 24) {
  const items = Array.from({ length: total }, (_, index) => syntheticRoonItem(index));
  const page = (request: PageRequest): RoonLibraryPage => ({ items: items.slice(request.offset, request.offset + request.limit), ...request, total, hasMore: request.offset + request.limit < total });
  const sequence: string[] = [];
  const requests: PageRequest[] = [];
  const gate = deferred<void>();
  let dispatchedReferences: readonly string[] = [], playCount = 0;
  const errors: unknown[] = [];
  const api = {
    checkFavorite: async () => ({ favorite: false }),
    getTrackLikeStatus: async () => ({ liked: false }),
    getLyrics: async () => ({ status: 'unavailable', lines: [], activeLineIndex: -1, timingSource: 'static' }),
    playRoonTrack: async (_reference: string, _zone: string, references?: readonly string[]) => {
      sequence.push('playRoonTrack'); playCount++; dispatchedReferences = references ?? [];
    },
    getPlaybackState: async () => ({ ...playbackSnapshot(1), source: 'roon' }),
  } as unknown as MusicBridgePublicApi;
  const session = usePlaybackSession({
    api, getSelectedZone: () => ({ zoneId: 'synthetic-zone', displayName: '合成设备', selected: true }),
    getZoneLifecycleStatus: () => 'selected', getSelectedQuality: () => 'auto',
    getMatchResult: () => undefined, getPendingMatch: () => undefined, onMatchTracks: () => undefined,
    getRoonPlaybackContext: () => ({ reference: 'synthetic-context', page: page({ offset: 0, limit }), load: async (_reference, request) => {
      requests.push({ ...request }); sequence.push(`page-request:${request.offset}`);
      if (request.offset === limit) await gate.promise;
      const result = page(request); sequence.push(`page-return:${request.offset}`); return result;
    } }),
    resolveFavoriteDescriptor: favoriteDescriptorForRoonItem,
    onEnterNowPlaying: () => sequence.push('now-playing-opened'), clearActionError: () => undefined,
    onActionMessage: () => undefined, onError: (error) => errors.push(error), onToast: () => undefined,
  });
  try {
    const playing = session.playRoonLibraryTrack(items[0]!);
    await nextTurn();
    const beforeRemainingPageReleased = { playCount, requestedPages: requests.length, sequence: [...sequence] };
    gate.complete();
    await playing;
    await nextTurn();
    assert.equal(errors.length, 0, '合成播放入口失败');
    assert.equal(playCount, 1, '合成播放没有派发一次');
    const playIndex = sequence.indexOf('playRoonTrack');
    const pagesCompletedBeforePlayback = sequence.slice(0, playIndex).filter((value) => value.startsWith('page-return:')).length;
    return {
      scenario: 'renderer-playback-remaining-pages', evidence: '真实 usePlaybackSession 调用真实 collectRoonPlaybackContext，API 为合成 Fake',
      total, initialPageItems: Math.min(total, limit), pageLimit: limit,
      beforeRemainingPageReleased, remainingPageRequests: requests, pagesCompletedBeforePlayback,
      allRemainingPagesReadBeforePlayback: pagesCompletedBeforePlayback === Math.ceil(total / limit) - 1,
      dispatchedReferenceCount: dispatchedReferences.length,
      uniqueDispatchedReferenceCount: new Set(dispatchedReferences).size, sequence,
    };
  } finally { gate.complete(); session.dispose(); }
}

export async function detailFirstPageScenario(kind: 'album' | 'artist' | 'playlist', total = 250, limit = 24) {
  let level = 0;
  const loads: Array<{ offset: number; requestedCount: number; returnedCount: number }> = [];
  const browse: RoonBrowseApi = {
    browse(options, callback) { level = options.pop_all ? 0 : 1; callback(false, { action: 'list', list: { level, count: level === 0 ? 1 : total } }); },
    load(options, callback) {
      const offset = Number(options.offset), requestedCount = Number(options.count);
      if (options.level === 0) { callback(false, { offset, items: [{ title: '合成入口', subtitle: '合成艺人', hint: 'list', item_key: `${kind}:1` }] }); return; }
      const returnedCount = Math.max(0, Math.min(requestedCount, total - offset));
      loads.push({ offset, requestedCount, returnedCount });
      callback(false, { offset, items: Array.from({ length: returnedCount }, (_, index) => ({ title: `合成条目${offset + index}`, subtitle: '合成艺人', hint: kind === 'artist' ? 'list' : 'action_list', item_key: `entry:${offset + index}` })) });
    },
  };
  const service = createRoonLibraryService({ browse, image: { get_image() { throw new Error('基线禁止请求图片'); } } });
  const root = await (kind === 'album' ? service.browseAlbums({ offset: 0, limit }) : kind === 'artist' ? service.browseArtists({ offset: 0, limit }) : service.browsePlaylists({ offset: 0, limit }));
  assert.ok(root.items[0], '合成目录入口缺失');
  const entity = root.items[0];
  const result = await (kind === 'album' ? service.browseAlbum(entity, { offset: 0, limit }) : kind === 'artist' ? service.browseArtist(entity, { offset: 0, limit }) : service.browsePlaylist(entity, { offset: 0, limit }));
  const loadedBeforeFirstPage = loads.reduce((sum, load) => sum + load.returnedCount, 0);
  return {
    scenario: `detail-first-page-${kind}`, evidence: '真实 createRoonLibraryService + 合成 Roon Browse SDK 回调',
    total, requestedPageItems: limit, returnedPageItems: result.items.length,
    reportedTotal: result.total, sdkLoads: loads, sdkLoadCount: loads.length,
    loadedBeforeFirstPage, collectedFullListBeforeReturningFirstPage: loadedBeforeFirstPage >= total,
  };
}

export function publisherScenario(queueSize: number) {
  const ticks: Array<{ tick: number; eventCount: number; eventCounts: Record<string, number>; jsonBytesEstimate: number }> = [];
  let current: (typeof ticks)[number];
  const publish = createPlaybackEventPublisher((event: TypedIpcEvent) => {
    current.eventCount++;
    current.eventCounts[event.event] = (current.eventCounts[event.event] ?? 0) + 1;
    current.jsonBytesEstimate += Buffer.byteLength(JSON.stringify(event), 'utf8');
  });
  const initial = playbackSnapshot(queueSize);
  for (let tick = 1; tick <= 2; tick++) {
    current = { tick, eventCount: 0, eventCounts: {}, jsonBytesEstimate: 0 };
    ticks.push(current);
    publish({ ...initial, positionMs: (tick - 1) * 1_000 });
  }
  return {
    scenario: `playback-publisher-${queueSize}`, evidence: '真实 createPlaybackEventPublisher；保持同一 queue 对象，两次进度 tick',
    queueSize, ticks, eventCount: ticks.reduce((sum, tick) => sum + tick.eventCount, 0),
    jsonBytesEstimate: ticks.reduce((sum, tick) => sum + tick.jsonBytesEstimate, 0),
    byteEstimateBoundary: '对合成事件实际 JSON.stringify 后计算 UTF-8 字节；不是 Electron IPC structured-clone 实际传输大小',
  };
}

export async function duplicateContextScenario() {
  const first = syntheticRoonItem(0), other = syntheticRoonItem(1), repeated = { ...syntheticRoonItem(2), title: first.title };
  const distinct = await collectRoonPlaybackContext(first, { items: [first, other, repeated], offset: 0, limit: 24, total: 3, hasMore: false });
  const sameReference = await collectRoonPlaybackContext(first, { items: [first, other, { ...first, title: '同引用末次元数据' }], offset: 0, limit: 24, total: 3, hasMore: false });
  return {
    scenario: 'duplicate-context-semantics', evidence: '真实 collectRoonPlaybackContext；仅观测既有语义',
    distinctOccurrencesInput: 3, distinctOccurrencesCollected: distinct.length,
    distinctOccurrencesPreserveOrder: distinct.map((item) => item.reference).join() === [first, other, repeated].map((item) => item.reference).join(),
    sameReferenceInput: 3, sameReferenceCollected: sameReference.length,
    sameReferenceLastMetadataWins: sameReference[0]?.title === '同引用末次元数据',
  };
}

export async function multiDiscScenario() {
  let location: 'root' | 'album' | 'disc:1' | 'disc:2' = 'root';
  const service = createRoonLibraryService({
    browse: {
      browse(options, callback) {
        if (options.pop_all) location = 'root';
        else if (options.pop_levels === 1 || options.item_key === 'album:multi') location = 'album';
        else if (options.item_key === 'disc:1' || options.item_key === 'disc:2') location = options.item_key;
        else { callback('合成 SDK 收到未预期请求', undefined); return; }
        callback(false, { action: 'list', list: { level: location === 'root' ? 0 : location === 'album' ? 1 : 2, count: location === 'root' ? 1 : location === 'album' ? 2 : 3 } });
      },
      load(options, callback) {
        const items = location === 'root' ? [{ title: '合成多碟专辑', item_key: 'album:multi', hint: 'list' }]
          : location === 'album' ? [1, 2].map((disc) => ({ title: `Disc ${disc}`, item_key: `disc:${disc}`, hint: 'list' }))
            : [1, 2, 3].map((number) => ({ title: number === 2 ? '合成其他曲' : '合成重复曲', subtitle: '合成艺人', item_key: number === 2 ? 'track:other' : 'track:repeat', hint: 'action_list', track_number: number }));
        const offset = Number(options.offset), count = Number(options.count);
        callback(false, { offset, items: items.slice(offset, offset + count) });
      },
    }, image: { get_image() { throw new Error('基线禁止请求图片'); } },
  });
  const root = await service.browseAlbums({ offset: 0, limit: 24 });
  assert.ok(root.items[0]);
  const result = await service.browseAlbum(root.items[0], { offset: 0, limit: 24 });
  return {
    scenario: 'multi-disc-source-index-semantics', evidence: '真实 Roon Library 多碟下钻；相同 item_key 的出现由 sourceIndex 区分',
    total: result.total, returned: result.items.length,
    items: result.items.map((item) => ({ discNumber: item.discNumber, trackNumber: item.trackNumber, sourceIndex: item.browseContext?.sourceIndex })),
    uniqueOccurrencePathCount: new Set(result.items.map((item) => item.browseContext?.pathSignature)).size,
    repeatedTitleCount: result.items.filter((item) => item.title === '合成重复曲').length,
  };
}

function git(args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1_048_576 });
  if (result.status !== 0) throw new Error('无法读取当前 Git 基线身份');
  return result.stdout.trim();
}

export async function baselineIdentity() {
  const files = await Promise.all(measuredFiles.map(async (path) => ({ path, sha256: createHash('sha256').update(await readFile(resolve(ROOT, path))).digest('hex') })));
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const statusLines = git(['status', '--porcelain=v1', '--untracked-files=normal']).split('\n').filter(Boolean);
  return {
    gitSha: git(['rev-parse', 'HEAD']),
    implementation: { workingTreeDirty: statusLines.length > 0, dirtyImplementation: git(['diff', '--name-only', 'HEAD', '--', ...measuredFiles]).length > 0, sourceFingerprint: fingerprint, measuredSourceFiles: files },
    runtime: {
      nodeVersion: process.version, concurrency: 1,
      execution: 'Node + tsx 直接调用当前 TypeScript 实现；合成输入与 Fake SDK',
      buildNature: '未构建或启动 Electron；contracts dist 是源码模块已有的本地运行依赖',
      contractsDistIndexSha256: createHash('sha256').update(await readFile(resolve(ROOT, 'packages/contracts/dist/index.js'))).digest('hex'),
      baselineScriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    },
  };
}

export async function assertExternalOutput(output: string): Promise<string> {
  if (!isAbsolute(output) || !output.endsWith('.json')) throw new Error('--output 必须是外置 LifeWeave 上的绝对 JSON 文件路径');
  const [volume, volumes, parent] = await Promise.all([stat(EXTERNAL_ROOT), stat('/Volumes'), realpath(dirname(output))]);
  if (volume.dev === volumes.dev) throw new Error('LifeWeave 未确认为已挂载的外置卷，停止写入');
  const relation = relative(EXTERNAL_ROOT, parent);
  if (relation === '..' || relation.startsWith('../') || isAbsolute(relation)) throw new Error('--output 的真实父目录必须位于外置 LifeWeave');
  const parentStat = await stat(parent);
  if (parentStat.dev !== volume.dev) throw new Error('--output 不属于已核验的 LifeWeave 卷');
  await access(parent, constants.W_OK);
  return resolve(parent, output.slice(output.lastIndexOf('/') + 1));
}

export async function runBaseline(output: string) {
  if (!process.versions.node.startsWith('22.')) throw new Error('基线脚本要求 Node.js 22.x');
  const destination = await assertExternalOutput(output);
  const before = await baselineIdentity();
  const scenarios: unknown[] = [];
  scenarios.push(await rendererPlaybackScenario());
  for (const kind of ['album', 'artist', 'playlist'] as const) scenarios.push(await detailFirstPageScenario(kind));
  for (const size of [50, 500, 5_000]) scenarios.push(publisherScenario(size));
  scenarios.push(await duplicateContextScenario(), await multiDiscScenario());
  const after = await baselineIdentity();
  const report = {
    schemaVersion: 1, task: 'MBP-001', generatedAt: new Date().toISOString(), ...before,
    sourceStableDuringRun: before.gitSha === after.gitSha && before.implementation.sourceFingerprint === after.implementation.sourceFingerprint,
    nature: '合成结构基线；实际调用生产模块，不连接真实账号、Provider、Roon、设备或用户资料',
    scenarios,
    unmeasured: ['真实 Roon Browse 延迟和成功率', '真实 Provider 网络及限流', '真实音频/录音/设备状态与听感', 'Electron IPC structured-clone 实际字节', 'Renderer 帧时间与完整应用事件循环', '正式打包/签名/发布/Owner 验收'],
  };
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { output: destination, scenarioCount: scenarios.length, gitSha: before.gitSha, sourceStableDuringRun: report.sourceStableDuringRun };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output' || !args[1]) {
    console.error('用法：node --import tsx ../../scripts/performance/baseline.ts --output /Volumes/LifeWeave/Developer/CommandLine/tmp/已存在目录/baseline.json');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await runBaseline(args[1]))); }
    catch (error) { console.error(error instanceof Error ? error.message : '基线执行失败'); process.exitCode = 1; }
  }
}
