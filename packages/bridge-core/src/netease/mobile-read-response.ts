import { types as nodeTypes } from 'node:util';
import type { NeteaseMobileReadRequest } from './types.js';

const MAX_BYTES = 2 * 1024 * 1024, MAX_NODES = 65_536, MAX_DEPTH = 32;
const invalid = (): never => { throw new Error('移动SDK响应字段无效或超过原预算。'); };
type Fields = Readonly<Record<string, Picker>>;
type Picker = (value: unknown, depth: number) => unknown;
interface DataField { value: unknown }

/** 只捕获原实际端口读取的字段；无关SDK对象不枚举、不求值，也不跨出client。 */
export function projectMobileReadResponse(raw: unknown, operation: NeteaseMobileReadRequest['operation']): unknown {
  let nodes = 0, bytes = 0;
  function charge(depth: number, size = 0): void {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH || (bytes += size) > MAX_BYTES) return invalid();
  }
  function container(value: unknown, array = false): object {
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) return invalid();
    const prototype = Object.getPrototypeOf(value);
    if (array ? !Array.isArray(value) || prototype !== Array.prototype
      : Array.isArray(value) || prototype !== Object.prototype && prototype !== null) return invalid();
    // 常数次检查；不能为了拒绝污染键而遍历整个无关SDK扩展。
    for (const key of ['__proto__', 'prototype', 'constructor']) if (Object.getOwnPropertyDescriptor(value, key)) return invalid();
    return value;
  }
  function field(value: object, key: string): DataField | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
    return { value: descriptor.value as unknown };
  }
  const scalar: Picker = (value, depth) => {
    if (value !== null && !['boolean', 'number', 'string'].includes(typeof value)) return invalid();
    if (typeof value === 'string') {
      if (value.length > MAX_BYTES) return invalid();
      charge(depth, Buffer.byteLength(value, 'utf8') + 2);
    } else charge(depth, 8);
    // 不转换不安全数字；后续原mobileDataSnapshot仍会明确拒绝它。
    return value;
  };
  function record(fields: Fields, required: readonly string[] = []): Picker {
    return (value, depth) => {
      const source = container(value); charge(depth, 2);
      const output = Object.create(null) as Record<string, unknown>;
      for (const [name, pick] of Object.entries(fields)) {
        const member = field(source, name);
        if (!member) { if (required.includes(name)) return invalid(); continue; }
        bytes += name.length + 3; if (bytes > MAX_BYTES) return invalid();
        output[name] = pick(member.value, depth + 1);
      }
      return output;
    };
  }
  function array(maximum: number, pick: Picker, headOnly = false): Picker {
    return (value, depth) => {
      const source = container(value, true), length = Object.getOwnPropertyDescriptor(source, 'length')?.value as unknown;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum) return invalid();
      charge(depth, 2); const output: unknown[] = [];
      for (let index = 0; index < (headOnly ? Math.min(length, 1) : length); index++) {
        const member = field(source, String(index)); if (!member) return invalid();
        output.push(pick(member.value, depth + 1));
      }
      return output;
    };
  }
  const nullable = (pick: Picker): Picker => (value, depth) => value === null ? scalar(value, depth) : pick(value, depth);
  const itemId = record({ id: scalar }, ['id']);
  const artwork = { picUrl: scalar, blurPicUrl: scalar, coverImgUrl: scalar };
  const songArtist = record({ id: scalar, name: scalar });
  const albumArtist = record({ name: scalar });
  const song = record({ id: scalar, name: scalar, ar: array(32, songArtist),
    al: nullable(record({ id: scalar, name: scalar, ...artwork })), dt: scalar,
    // 原端口只使用首个别名；长度仍受原节点预算约束，不读取其余无关项。
    alia: nullable(array(MAX_NODES, scalar, true)) });
  const album = record({ id: scalar, name: scalar, size: scalar, trackCount: scalar,
    artists: nullable(array(32, albumArtist)), artist: nullable(albumArtist), type: scalar, publishTime: scalar, ...artwork });
  // 缺失成员保持缺失，交原实际端口严格拒绝并记录闭集原因；不能补成空歌单。
  const artist = record({ id: scalar, name: scalar, albumSize: scalar, musicSize: scalar, briefDesc: scalar, ...artwork });
  const playlist = record({ id: scalar, name: scalar, trackIds: array(10_000, itemId), trackCount: scalar, updateTime: scalar,
    specialType: scalar, userId: scalar, creator: nullable(record({ userId: scalar })), ...artwork });
  const userPlaylist = record({ id: scalar, specialType: scalar, userId: scalar, creator: nullable(record({ userId: scalar })) });
  const lyric = record({ lyric: scalar });
  const lyricFields = { lrc: lyric, yrc: lyric, tlyric: lyric, romalrc: lyric, yromalrc: lyric,
    uncollected: scalar, pureMusic: scalar, instrumental: scalar, nolyric: scalar };
  const media = record({ id: scalar, code: scalar,
    // 试播只读null/非null资格；非null对象保留为对象，原拒绝守卫仍必然生效。
    freeTrialInfo: (value, depth) => value !== null && typeof value === 'object' ? record({})(value, depth) : scalar(value, depth),
    md5: scalar, size: scalar, expi: scalar, url: scalar, level: scalar, type: scalar, encodeType: scalar, br: scalar });

  const envelope = container(raw), wrapped = field(envelope, 'body');
  const body = container(wrapped ? wrapped.value : raw), code = field(body, 'code');
  const dataRequired = operation === 'daily' || operation === 'personal-fm' || operation === 'stream' || operation === 'streams' || operation === 'lyrics';
  const data = dataRequired || code?.value === null || !code ? field(body, 'data') : undefined;
  let innerCode: DataField | undefined;
  if (code?.value === null || !code) {
    if (!data) return invalid();
    innerCode = field(container(data.value), 'code'); if (!innerCode) return invalid();
  }
  const common: Record<string, Picker> = { code: scalar };
  if (innerCode) common.data = record({ code: scalar });
  // 上游拒绝包不伪造列表；301/302与其它状态仍由原response/账户逻辑判断。
  if ((code?.value ?? innerCode?.value) !== 200) return record(common)(body, 0);
  let fields: Fields, required: readonly string[];
  switch (operation) {
    case 'directory-search': fields = { result: record({ songs: array(100, itemId), albums: array(100, album), artists: array(100, artist), songCount: scalar, albumCount: scalar, artistCount: scalar }) }; required = ['result']; break;
    case 'artist-profile': case 'artist-songs': fields = { artist, hotSongs: array(10000, itemId) }; required = ['artist', 'hotSongs']; break;
    case 'artist-albums': fields = { artist, hotAlbums: array(100, album), more: scalar }; required = ['artist', 'hotAlbums']; break;
    case 'daily': fields = { data: record({ code: scalar, dailySongs: array(100, itemId) }, ['dailySongs']) }; required = ['data']; break;
    case 'personal-fm': fields = { data: array(100, itemId) }; required = ['data']; break;
    case 'recommended-playlists': fields = { result: array(100, itemId) }; required = ['result']; break;
    case 'charts': fields = { list: array(100, itemId) }; required = ['list']; break;
    case 'new-albums': fields = { total: scalar, albums: array(100, album) }; required = ['total', 'albums']; break;
    case 'user-playlists': fields = { more: scalar, playlist: array(100, userPlaylist) }; required = ['playlist']; break;
    case 'playlist-detail': fields = { playlist }; required = ['playlist']; break;
    case 'song-detail': fields = { songs: array(100, song) }; required = ['songs']; break;
    case 'album': fields = { album, songs: array(10_000, song) }; required = ['album', 'songs']; break;
    case 'stream': case 'streams': fields = { data: array(100, media) }; required = ['data']; break;
    case 'lyrics': {
      fields = lyricFields; required = [];
      if (data && data.value !== null && typeof data.value === 'object') {
        if (nodeTypes.isProxy(data.value)) return invalid();
        if (!Array.isArray(data.value)) fields = { ...lyricFields, data: record({ code: scalar, ...lyricFields }) };
      }
      // data为其它JSON类型时原端口使用顶层歌词；该无关分支不构造空内容。
      if (!Object.keys(lyricFields).some(name => field(body, name) || data && data.value !== null && typeof data.value === 'object'
        && !Array.isArray(data.value) && field(container(data.value), name))) return invalid();
      break;
    }
    default: return invalid();
  }
  return record({ ...common, ...fields }, required)(body, 0);
}
