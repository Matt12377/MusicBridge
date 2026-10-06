import type { AlbumBoundaryCandidate, AlbumNameCandidate, AlbumNameRuleInput, AlbumNameRuleResult, ManualAlbumBoundary, NameDirectoryFact, NameDirectoryRole, NameEvidenceSource, NameRuleEvidence, VersionNameToken } from '@music-bridge/contracts';

/** 有限字符映射是显示兼容规则，并非通用繁简转换；raw 始终保持原文。 */
const traditionalPairs = ['與与','對对','話话','愛爱','張张','學学','響响','動动','車车','專专','輯辑','臺台','灣湾','韓韩','國国','頭头','復复','刻刻','銀银','環环','華华','滾滚','飛飞','寶宝','麗丽','風风','盤盘','帶带','搖摇','滅灭','後后','無无','損损','軌轨','聲声','鎮镇','燈灯','憶忆','榮荣','機机','構构','彙汇','裝装','單单','樂乐','發发','壓压','膠胶','這这','傳传','陳陈','劉刘','孫孙','鄧邓','黃黄','齊齐','許许','雲云'];
const traditional = new Map(traditionalPairs.map(pair => [...pair] as [string, string]));
const normalize = (value: string): string => [...value.normalize('NFKC')].map(c => traditional.get(c) ?? c).join('').trim().replace(/\s+/gu, ' ');
const meaningful = (value: string): boolean => /[\p{L}\p{N}]/u.test(value);
const edges = (value: string): string => value.replace(/^[\s._—–·•|/\\+\-]+|[\s._—–·•|/\\+\-]+$/gu, '').trim();
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const formats = /(?:^|[^a-z0-9])(?:wav|wave|flac|ape|dsd|dff|dsf|mp3|m4a|aac|alac|aiff?|sacd(?:iso)?|shm(?:-?cd)?|uhqcd|hqcd|xrcd|k2hd|lpcd(?:45)?|hdcd|cue|hi[ -]?res|lossless|qobuz|tidal|mora|amazon|amz|sony)(?:$|[^a-z0-9])/iu;
const technicalNumbers = /^(?:(?:flac|wav|dsd|dsf)\s*)?(?:16|20|24|32)(?:\s*(?:bit|b))?\s*[-_/ ]?\s*(?:44(?:\.1)?|48|88(?:\.2)?|96|176(?:\.4)?|192|352(?:\.8)?|384)(?:\s*k?hz)?$|^\d\s*bit\s*\d(?:\.\d+)?\s*mhz$|^\d{4}(?:\.1)?$/iu;
const editionWords = /版|唱片|压制|银圈|胶圈|金碟|母盘|母带|复黑|限量|限定|珍藏|典藏|收藏|套装|首批|再版|复刻|发行|引进|IFPI|原抓|抓轨|整轨|分轨|无损|华纳|环球|滚石|飞碟|宝丽金|百代|remaster(?:ed)?|deluxe|anniversary|limited\s*edition/iu;
const performanceSemantics = /演唱会|现场|混音|remix|live|acoustic|伴奏|instrumental/iu;
const noiseKeys = new Set(['qobuz','tidal','sony','mora','amazon','amz','hires','mq','mqs','m','cm','台湾','台版','香港','港版','日本','韩国','德国','美国','内地','大陆','新宝艺','环球','华纳','滚石','飞碟','宝丽金','华星','百代','广东音像','风林','常喜唱片']);
const placeholders = new Set(['cdimage','unknown','unknownalbum','unknowntitle','未知专辑','未分类专辑','未命名专辑','track','audio','cd','disc']);
/** 候选键允许折叠展示差异，不能传入任何身份构造或合并操作。 */
export function canonicalNameCandidateKey(value: string): string {
  return normalize(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
export const isPlaceholderAlbumName = (value: string): boolean => placeholders.has(canonicalNameCandidateKey(value));
const pairs: Record<string, string> = { '[': ']', '【': '】', '(': ')', '{': '}', '《': '》', '〈': '〉', '（': '）', '［': '］', '｛': '｝' };
interface Bracket { content: string; start: number; end: number }
function bracketAt(value: string, start: number): Bracket | null {
  const opening = value[start]!, closing = pairs[opening];
  if (!closing) return null;
  let depth = 0;
  for (let i = start; i < value.length; i++) {
    if (value[i] === opening) depth++;
    if (value[i] === closing && --depth === 0) return { content: value.slice(start + 1, i).trim(), start, end: i + 1 };
  }
  return null;
}
function trailingBracket(value: string): Bracket | null {
  for (let i = 0; i < value.length; i++) { const group = bracketAt(value, i); if (group?.end === value.length) return group; }
  return null;
}
function noise(value: string): boolean {
  const normalized = normalize(value), key = canonicalNameCandidateKey(value);
  if (performanceSemantics.test(normalized)) return false;
  return !key || /^(?:19|20)\d{2}(?:[./-]\d{1,2}){0,2}$/u.test(normalized) || formats.test(normalized)
    || technicalNumbers.test(normalized) || editionWords.test(normalized) || /^vol(?:ume)?\.?\s*\d+$/iu.test(normalized)
    || /^(?:\d+\s*)?(?:cd|disc|disk)\s*(?:\d+|[a-z])?$/iu.test(normalized) || noiseKeys.has(key);
}
function stripTrailingGroups(value: string): string {
  let current = value;
  for (;;) { const group = trailingBracket(current); if (!group || !noise(group.content) || group.start === 0 && !meaningful(edges(current.slice(0, group.start)))) break; current = edges(current.slice(0, group.start)); }
  return current;
}
function stripPlainNoise(value: string): string {
  const patterns = [
    /\s*(?:[-–—]\s*)?(?:wav|flac|ape|dsd|dff|dsf|mp3|m4a|aac|alac|aiff?|sacd(?:iso)?|shm(?:-?cd)?|uhqcd|hqcd|xrcd|k2hd|lpcd(?:45)?|hdcd|cue)(?:\s*[+/| ]\s*(?:wav|flac|ape|dsd|dff|dsf|mp3|m4a|aac|alac|aiff?|sacd|cue))*\s*$/iu,
    /\s*(?:[-–—]\s*)?(?:(?:flac|wav|dsd|dff|dsf)?\s*(?:16|20|24|32)\s*(?:bit|b)?\s*[-_/ ]?\s*(?:44(?:\.1)?|48|88(?:\.2)?|96|176(?:\.4)?|192|352(?:\.8)?|384)(?:\s*k?hz)?|(?:44\.1|48|88\.2|96|176\.4|192|352\.8|384)\s+(?:16|20|24|32)|1\s*bit\s+\d(?:\.\d+)?\s*mhz|(?:16|24|32)(?:44|48|96|192)|1644(?:\.1)?)\s*$/iu,
    /\s+(?:19|20)\d{2}(?:年)?\s*$/u,
    /\s+(?:\d+\s*)?(?:cd|disc|disk)\s*(?:\d+|[a-z])?\s*$/iu,
    /\s+(?:第一版|首版|头版|再版|复刻版|限量版|限定版|珍藏版|典藏版|特别版|完整版)(?:\s.*)?$/u,
    /\s+(?:韩德银圈版|(?:香港|台湾|日本|韩国|德国|美国|内地|大陆|新加坡|马来西亚).*(?:版|压制|银圈|胶圈|IFPI))\s*$/iu,
    /\s+(?:飞碟|华纳|环球|滚石|宝丽金|百代|EMI|Sony|ABC|常喜|风林|东升)(?:唱片|音乐)?(?:\s.*)?$/iu,
    /\s+(?:\d+[:：]\d+\s*)?(?:母盘|母带|原抓|抓轨|整轨|分轨|无损).*$/u,
    /\s+(?:remaster(?:ed)?|deluxe|anniversary|limited\s*edition)\s*$/iu,
  ];
  let result = value.replace(/([\]】)])(?:cd|disc|disk)\s*(?:\d+|[a-z])\s*$/iu, '$1');
  for (const pattern of patterns) { const next = edges(result.replace(pattern, '')); if (meaningful(next)) result = next; }
  return result;
}
export function cleanArtistName(value: string): string {
  const fallback = normalize(value); let result = fallback;
  for (let i = 0; i < 4; i++) { const next = edges(stripTrailingGroups(result).replace(/\s*(?:专辑|合集|合辑)\s*$/u, '')); if (next === result) break; result = next; }
  return meaningful(result) ? result : fallback;
}
export function cleanAlbumName(value: string, artistName?: string): string {
  const fallback = normalize(value), artist = artistName ? cleanArtistName(artistName) : ''; let result = fallback;
  for (let pass = 0; pass < 8; pass++) {
    const previous = result;
    for (;;) { const group = bracketAt(result, 0); if (!group || !noise(group.content) || /^(?:\(?)(?:19|20)\d{2}\)?\s+\S/u.test(group.content)) break; result = edges(result.slice(group.end)); }
    // 纯年份标题后只有技术括号时先移除括号，避免将年份误认作日期前缀。
    if (/^(?:19|20)\d{2}\s+[\[【(]/u.test(result)) { const stripped = stripTrailingGroups(result); if (/^(?:19|20)\d{2}$/u.test(stripped)) result = stripped; }
    result = edges(result).replace(/^\d{1,3}\s*(?:、|[.．](?!\d))\s*(?=\S)/u, '');
    const dateRules = [/^(?:19|20)\d{6}\s*[-_.—–]*\s*(\S.*)$/u, /^[\[【(]\s*(?:19|20)\d{2}\s*[-_.—–]+\s*(\S.*)$/u,
      /^(?:19|20)\d{2}[._-](?:0?[1-9]|1[0-2])(?:[._-](?:0?[1-9]|[12]\d|3[01]))?(?!\d)\s*[-_.—–]*\s*(\S.*)$/u,
      /^(?:19|20)\d{2}\s*(?:年\s*)?[-_.—–]+\s*(\S.*)$/u, /^(?:19|20)\d{2}\s+(?=[\[【《〈])(\S.*)$/u, /^\((?:19|20)\d{2}\)\s*[-_.—–]*\s*(\S.*)$/u];
    if (artist) dateRules.push(new RegExp(`^(?:19|20)\\d{2}\\s*(${escapeRegex(artist)}(?:\\s|[-_.—–《〈(【\\[]).*)$`, 'u'));
    const yearBracket = result.match(/^(?:19|20)\d{2}\s+(.+)$/u);
    const protectedYear = yearBracket && performanceSemantics.test(yearBracket[1]!);
    if (!protectedYear) for (const rule of dateRules) { const match = result.match(rule); if (match?.[1] && meaningful(match[1])) { result = edges(match[1]); break; } }
    if (artist) {
      const dated = result.match(new RegExp(`^${escapeRegex(artist)}\\s*((?:19|20)\\d{2}[-_.—–].*)$`, 'u'));
      const rule = new RegExp(`^${escapeRegex(artist)}(?:\\s*[-_.—–]+\\s*|\\s+|\\s*(?=[《〈(【\\[]))(\\S.*)$`, 'u');
      const match = dated ?? result.match(rule); if (match?.[1]) result = edges(match[1]);
    }
    const books = [...result.matchAll(/《([^》]+)》|〈([^〉]+)〉/gu)];
    if (books.length === 1) {
      const book = books[0]!, prefix = edges(result.slice(0, book.index)), suffix = result.slice(book.index! + book[0].length);
      const trusted = !prefix || artist && canonicalNameCandidateKey(prefix).includes(canonicalNameCandidateKey(artist)) || /唱片|文化|音乐|专辑/u.test(prefix);
      let rest = normalize(suffix); for (let n = 0; n < 6; n++) rest = edges(stripPlainNoise(stripTrailingGroups(rest)).replace(/(?:专辑|双碟装)$/u, ''));
      if (trusted && (!rest || noise(rest))) result = book[1] ?? book[2]!;
    }
    result = stripPlainNoise(stripTrailingGroups(result));
    const withoutWarezSuffix = result.replace(/([\]】)》〉])\s*[._-]*专辑[._-]*$/u, '$1');
    if (withoutWarezSuffix !== result) { const group = bracketAt(withoutWarezSuffix, 0); result = group?.end === withoutWarezSuffix.length && meaningful(group.content) ? group.content : withoutWarezSuffix; }
    const whole = bracketAt(result, 0); if (whole?.end === result.length && (!noise(whole.content) || /^\(?(?:19|20)\d{2}\)?\s+\S/u.test(whole.content)) && meaningful(whole.content)) result = whole.content;
    result = normalize(edges(result));
    if (result === previous) break;
  }
  return meaningful(result) ? result : fallback;
}
/** 歌曲标题仅规范空白/宽度；演唱会、混音和年份可属于标题语义。 */
export const cleanTrackTitle = (value: string): string => normalize(value);

export function extractVersionTokens(raw: string, source: NameEvidenceSource): VersionNameToken[] {
  const tokens: VersionNameToken[] = [];
  const rules: [VersionNameToken['kind'], RegExp][] = [
    ['edition', /(?:首版|第一版|头版|頭版|再版|复刻(?:版)?|復刻(?:版)?|[^\s\[\]【】()（）《》〈〉]*版|remaster(?:ed)?|deluxe|anniversary|limited\s*edition|Taylor['’]s\s+Version)/giu],
    ['format', /(?:\b(?:flac|wav|dsd|dsf)(?:16|20|24|32)(?:bit|b)?(?:44(?:\.1)?|48|88(?:\.2)?|96|176(?:\.4)?|192|352(?:\.8)?|384)(?:k?hz)?\b|\b(?:wav|wave|flac|ape|dsd|dff|dsf|mp3|m4a|aac|alac|aiff?|sacd(?:iso)?|shm-?cd|uhqcd|hqcd|xrcd|k2hd|lpcd(?:45)?|hdcd|cue|hi[ -]?res|lossless)\b|\b(?:16|20|24|32)\s*(?:bit|b)?\s*[-_/ ]?\s*(?:44(?:\.1)?|48|88(?:\.2)?|96|176(?:\.4)?|192|352(?:\.8)?|384)(?:\s*k?hz)?\b|\b(?:44\.1|48|88\.2|96|176\.4|192|352\.8|384)\s+(?:16|20|24|32)\b|\b\d\s*bit\s*\d(?:\.\d+)?\s*mhz\b|\b(?:1644(?:\.1)?|2448|2496|(?:16|24|32)(?:44|48|96|192))\b)/giu],
    ['disc', /(?:\b(?:cd|disc|disk)\s*\d+\b|\b\d+\s*cd\b|[碟盘盤]\s*\d+)/giu],
    ['year', /(?:19|20)\d{2}/gu],
  ];
  const append = (kind: VersionNameToken['kind'], start: number, end: number): void => {
    if (!tokens.some(token => token.kind === kind && token.start === start && token.end === end)) tokens.push({ raw: raw.slice(start, end), source, kind, start, end });
  };
  for (const [kind, pattern] of rules) for (const match of raw.matchAll(pattern)) append(kind, match.index, match.index + match[0].length);
  const technical = new RegExp(rules[1]![1].source, 'iu');
  const retainNoise = (start: number, end: number): void => {
    const content = normalize(raw.slice(start, end));
    if (performanceSemantics.test(content)) return;
    if (formats.test(content) || technical.test(content) || technicalNumbers.test(content) && !/^(?:19|20)\d{2}$/u.test(content)) append('format', start, end);
    if (editionWords.test(content) || noiseKeys.has(canonicalNameCandidateKey(content))) append('edition', start, end);
  };
  // 与展示清洗共用噪声判定，完整保存首批、银圈及宽度规范化前的技术原文。
  for (let index = 0; index < raw.length; index++) {
    const group = bracketAt(raw, index);
    if (group && noise(group.content)) retainNoise(group.start + 1, group.end - 1);
  }
  const end = raw.trimEnd().length;
  for (const match of raw.matchAll(/\s+/gu)) {
    const start = match.index + match[0].length, suffix = normalize(raw.slice(start, end));
    if (suffix && stripPlainNoise(`音乐 ${suffix}`) === '音乐') retainNoise(start, end);
  }
  return tokens.sort((a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind));
}
export function nameEvidence(raw: string, source: NameEvidenceSource, artistName?: string): NameRuleEvidence {
  // 必须先采集原文版本事实，再执行展示清洗。
  const versionTokens = extractVersionTokens(raw, source);
  const display = source === 'artist' || source === 'albumArtist' ? cleanArtistName(raw) : source === 'title' ? cleanTrackTitle(raw) : cleanAlbumName(raw, artistName);
  return { raw, display, canonicalKey: canonicalNameCandidateKey(display), searchAliases: [...new Set([raw, display])], versionTokens };
}
export function coverSearchKeyword(artist: string, album: string): string { return [artist.trim(), album.trim()].filter(Boolean).join(' '); }

function candidates(input: AlbumNameRuleInput, field: 'artist' | 'album', source: 'artist' | 'albumArtist' | 'album', artist: string): AlbumNameCandidate[] {
  const cache = new Map<string, { value: string; key: string; valid: boolean }>(), groups = new Map<string, { value: string; ids: string[] }>(); let valid = 0;
  for (const member of input.members) {
    const raw = member[source]; if (!raw?.trim()) continue;
    let cleaned = cache.get(raw); if (!cleaned) {
      const value = field === 'artist' ? cleanArtistName(raw) : cleanAlbumName(raw, artist), key = canonicalNameCandidateKey(value);
      const tokens = extractVersionTokens(value, source).filter(token => token.kind === 'format' || token.kind === 'edition');
      let remainder = value;
      for (const token of [...tokens].sort((a, b) => b.start - a.start)) remainder = remainder.slice(0, token.start) + remainder.slice(token.end);
      const noiseOnly = !performanceSemantics.test(normalize(value)) && (noiseKeys.has(key) || tokens.length > 0 && /^[\s\p{P}\p{S}]*$/u.test(remainder));
      cleaned = { value, key, valid: Boolean(key) && !noiseOnly && !(field === 'album' && isPlaceholderAlbumName(value)) }; cache.set(raw, cleaned);
    }
    if (!cleaned.valid) continue; valid++;
    const group = groups.get(cleaned.key) ?? { value: cleaned.value, ids: [] }; group.ids.push(member.trackId); groups.set(cleaned.key, group);
  }
  const ranked = [...groups].sort((a, b) => b[1].ids.length - a[1].ids.length || a[0].localeCompare(b[0])), tied = ranked.length > 1 && ranked[0]![1].ids.length === ranked[1]![1].ids.length;
  return ranked.map(([key, group], index) => {
    const coverage = input.members.length ? group.ids.length / input.members.length : 0, consistency = valid ? group.ids.length / valid : 0;
    const confidence = tied && group.ids.length === ranked[0]![1].ids.length ? 'ambiguous' : index === 0 && coverage >= 0.7 && consistency >= 0.7 ? 'high' : 'low';
    const directoryValue = field === 'artist' ? cleanArtistName(input.artistName) : cleanAlbumName(input.albumName, artist);
    const corroborated = canonicalNameCandidateKey(directoryValue) === key;
    return { field, source, value: group.value, canonicalKey: key, supportingTrackIds: [...group.ids], validTagCount: valid, totalTrackCount: input.members.length, coverage, consistency, confidence, needsConfirmation: confidence !== 'high' || !corroborated };
  });
}
export function resolveAlbumNameCandidates(input: AlbumNameRuleInput): AlbumNameRuleResult {
  if (new Set(input.members.map(member => member.trackId)).size !== input.members.length) throw new Error('专辑成员身份重复，无法计算完整覆盖率');
  const manual = input.manual ? { ...input.manual } : null;
  const artistCandidates = [...candidates(input, 'artist', 'albumArtist', input.artistName), ...candidates(input, 'artist', 'artist', input.artistName)];
  const artistRaw = manual?.artistName ?? artistCandidates.find(candidate => !candidate.needsConfirmation)?.value ?? input.artistName;
  const albumCandidates = candidates(input, 'album', 'album', artistRaw);
  const albumRaw = manual?.albumName ?? albumCandidates.find(candidate => !candidate.needsConfirmation)?.value ?? input.albumName;
  const evidenceCache = new Map<string, NameRuleEvidence>();
  const memberEvidence = input.members.map(member => {
    const result: AlbumNameRuleResult['memberEvidence'][number] = { trackId: member.trackId };
    for (const field of ['title', 'artist', 'albumArtist', 'album'] as const) {
      const raw = member[field]; if (raw === undefined) continue;
      const cacheKey = `${field}\u0000${raw}`;
      let evidence = evidenceCache.get(cacheKey); if (!evidence) { evidence = nameEvidence(raw, field, artistRaw); evidenceCache.set(cacheKey, evidence); }
      result[field] = { ...evidence, searchAliases: [...evidence.searchAliases], versionTokens: evidence.versionTokens.map(token => ({ ...token })) };
    }
    return result;
  });
  return { artist: nameEvidence(artistRaw, 'artist'), album: nameEvidence(albumRaw, 'album', artistRaw), rawNames: { artistName: input.artistName, albumName: input.albumName },
    rawVersionTokens: [...extractVersionTokens(input.artistName, 'artist'), ...extractVersionTokens(input.albumName, 'album')], memberEvidence,
    members: input.members.map(member => ({ ...member })), candidates: [...artistCandidates, ...albumCandidates], manual, aiMode: input.aiMode };
}

const directoryKey = (name: string): string => normalize(name).toLowerCase().replace(/[ _-]/gu, '');
export function classifyDirectoryName(name: string): NameDirectoryRole {
  const key = directoryKey(name);
  if (['album', 'albums', '专辑'].includes(key)) return 'album-container';
  if (/合集|合辑|全集|套装|汇总|collection|\d+张/u.test(key)) return 'collection-container';
  if (/^(?:cd|disc|disk|d|碟|盘)\p{Nd}+$/u.test(key)) return 'disc';
  if (/^(?:wav|wave|flac|ape|dsd|dff|dsf|sacd|hires|hirez|highres|lossless)$/u.test(key)
    || /^(?:wav|flac|ape|dsd|dff|dsf)(?:(?:16|20|24|32|64|128|256|512|1024)(?:bit|b)?(?:\/?(?:44(?:\.1)?|48|88(?:\.2)?|96|176(?:\.4)?|192|352(?:\.8)?|384))?(?:k?hz)?|\d+(?:\.\d+)?mhz)$/u.test(key)) return 'format';
  if (/版|version|edition|press/u.test(key)) return 'version';
  if (/^\p{Nd}{1,3}(?:$|[ ._、-])/u.test(name.trim())) return 'track';
  return 'ordinary';
}
export function inferAlbumBoundaries(facts: readonly NameDirectoryFact[], artistRootId: string, manual: readonly ManualAlbumBoundary[] = []): AlbumBoundaryCandidate[] {
  const byId = new Map(facts.map(fact => [fact.id, fact])); if (byId.size !== facts.length) throw new Error('目录事实身份重复');
  const overrides = new Map(manual.map(item => [item.directoryId, item.boundaryId]));
  const siblingsByParent = new Map<string | null, NameDirectoryFact[]>();
  for (const fact of facts) if (fact.directAudioCount > 0) { const siblings = siblingsByParent.get(fact.parentId) ?? []; siblings.push(fact); siblingsByParent.set(fact.parentId, siblings); }
  const siblingFacts = new Map([...siblingsByParent].map(([parentId, siblings]) => [parentId, {
    versionCount: siblings.filter(other => classifyDirectoryName(other.name) === 'version').length,
    numberedCount: siblings.filter(other => /^\d{1,2}$/u.test(other.name.trim()) && Number(other.name) > 0).length,
    trackFolders: siblings.length >= 2 && siblings.every(other => other.directAudioCount <= 1 && classifyDirectoryName(other.name) === 'track'),
  }]));
  return facts.filter(fact => fact.directAudioCount > 0 && fact.id !== artistRootId).map(fact => {
    const boundary = overrides.get(fact.id); if (boundary !== undefined) return { directoryId: fact.id, boundaryId: boundary, reason: 'manual', needsConfirmation: false };
    const siblings = siblingFacts.get(fact.parentId)!, role = classifyDirectoryName(fact.name);
    let boundaryId = fact.id; let reason: AlbumBoundaryCandidate['reason'] = 'directory';
    if (fact.parentId && fact.parentId !== artistRootId) {
      if (role === 'disc' || role === 'format') { boundaryId = fact.parentId; reason = 'structural'; }
      else if (/^\d{1,2}$/u.test(fact.name.trim()) && Number(fact.name) > 0 && siblings.numberedCount >= 2) { boundaryId = fact.parentId; reason = 'numbered-discs'; }
      else if (fact.directAudioCount <= 1 && siblings.trackFolders) { boundaryId = fact.parentId; reason = 'track-folders'; }
    }
    return { directoryId: fact.id, boundaryId, reason, needsConfirmation: role === 'version' && siblings.versionCount >= 2 };
  });
}

export interface AlbumDirectoryInput {
  role: 'library' | 'artist' | 'album'; root: string; audioPaths: readonly string[]; cuePaths: readonly string[];
  directoryPaths?: readonly string[]; readErrorPaths?: readonly string[];
  metadataByPath?: Readonly<Record<string, { discNumber?: number; trackNumber?: number }>>;
}
export type AlbumDirectoryIssue = { type: 'singleFileNeedsConfirmation'; hasCue: boolean }
  | { type: 'metadataReadFailed' | 'trackNamedAudioFiles'; paths: string[] } | { type: 'uncertainAlbumBoundary' };
export interface AlbumDirectoryCandidate { boundaryPath: string; artistName: string; albumName: string; relativeAudioPaths: string[]; relativeCuePaths: string[]; issues: AlbumDirectoryIssue[]; needsAttention: boolean }
export interface AlbumDirectoryResult { albums: AlbumDirectoryCandidate[]; looseAudioPaths: string[]; error: 'noAlbumsFound' | null }
/** 位置字符串只用来分析已经捕获的事实；它不是持久专辑/曲目身份。 */
export function discoverAlbumDirectoryCandidates(input: AlbumDirectoryInput): AlbumDirectoryResult {
  const trim = (value: string): string => value.replace(/^\/+|\/+$/gu, '');
  const root = trim(input.root), parentOf = (value: string): string => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
  const basename = (value: string): string => value.slice(value.lastIndexOf('/') + 1);
  const under = (value: string, base: string): boolean => !base || value === base || value.startsWith(`${base}/`);
  const relative = (value: string, base: string): string => base ? value.slice(base.length + 1) : value;
  const directories = new Set((input.directoryPaths ?? []).map(trim));
  const audio = [...new Set(input.audioPaths.map(trim))].filter(value => !directories.has(value) && under(value, root));
  const cues = [...new Set(input.cuePaths.map(trim))].filter(value => !directories.has(value) && under(value, root));
  const counts = new Map<string, number>(); for (const value of audio) counts.set(parentOf(value), (counts.get(parentOf(value)) ?? 0) + 1);
  const facts: NameDirectoryFact[] = [...counts].map(([id, directAudioCount]) => ({ id, parentId: parentOf(id), name: basename(id), directAudioCount }));
  const loose: string[] = [], groups = new Map<string, { artist: string; audio: string[]; uncertain: boolean }>();
  const artistGroups = new Map<string, { audio: string[]; facts: NameDirectoryFact[] }>();
  if (input.role === 'artist') artistGroups.set(root, { audio, facts });
  else if (input.role === 'library') {
    const artistRootFor = (value: string): string => { const name = relative(value, root).split('/')[0]!; return root ? `${root}/${name}` : name; };
    for (const value of audio) {
      if (parentOf(value) === root) { loose.push(value); continue; }
      const artistRoot = artistRootFor(value), group = artistGroups.get(artistRoot) ?? { audio: [], facts: [] }; group.audio.push(value); artistGroups.set(artistRoot, group);
    }
    for (const fact of facts) { const group = artistGroups.get(artistRootFor(fact.id)); if (group) group.facts.push(fact); }
  }
  if (input.role === 'album') groups.set(root, { artist: basename(parentOf(root)), audio: [...audio], uncertain: false });
  else for (const [artistRoot, artistGroup] of artistGroups) {
    const rootName = basename(artistRoot), artist = classifyDirectoryName(rootName) === 'album-container' ? basename(parentOf(artistRoot)) : rootName.replace(/\s+\d+\s*[张張](?:\[[^\]]+\])?\s*$/u, '').trim();
    const choices = inferAlbumBoundaries(artistGroup.facts, artistRoot);
    const choicesById = new Map(choices.map(choice => [choice.directoryId, choice]));
    for (const value of artistGroup.audio) {
      const directory = parentOf(value);
      if (directory === artistRoot || input.role === 'library' && directory === root) { loose.push(value); continue; }
      const choice = choicesById.get(directory); if (!choice) continue;
      const group = groups.get(choice.boundaryId) ?? { artist, audio: [], uncertain: false }; group.audio.push(value); group.uncertain ||= choice.needsConfirmation; groups.set(choice.boundaryId, group);
    }
  }
  const albums = [...groups].filter(([, group]) => group.audio.length > 0).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([boundaryPath, group]) => {
    const metadata = (value: string): { disc: number; track: number } => {
      const declared = input.metadataByPath?.[value];
      return { disc: declared?.discNumber ?? Number(value.match(/(?:^|\/)CD(\d+)\//iu)?.[1] ?? 1), track: declared?.trackNumber ?? Number(basename(value).match(/^\d+/u)?.[0] ?? Number.MAX_SAFE_INTEGER) };
    };
    const relativeAudioPaths = group.audio.sort((a, b) => metadata(a).disc - metadata(b).disc || metadata(a).track - metadata(b).track || a.localeCompare(b, 'en', { numeric: true })).map(value => relative(value, boundaryPath));
    const relativeCuePaths = cues.filter(value => under(value, boundaryPath)).sort().map(value => relative(value, boundaryPath));
    const issues: AlbumDirectoryIssue[] = [];
    if (group.uncertain) issues.push({ type: 'uncertainAlbumBoundary' });
    if (group.audio.length === 1) issues.push({ type: 'singleFileNeedsConfirmation', hasCue: relativeCuePaths.length > 0 });
    const errors = (input.readErrorPaths ?? []).filter(value => group.audio.includes(value)).map(value => relative(value, boundaryPath));
    if (errors.length) issues.push({ type: 'metadataReadFailed', paths: errors });
    const trackNamed = relativeAudioPaths.filter(value => /^track(?:\d+)?$/iu.test(basename(value).replace(/\.[^.]+$/u, '')));
    if (trackNamed.length) issues.push({ type: 'trackNamedAudioFiles', paths: trackNamed });
    return { boundaryPath, artistName: group.artist, albumName: basename(boundaryPath), relativeAudioPaths, relativeCuePaths, issues, needsAttention: issues.length > 0 };
  });
  return { albums, looseAudioPaths: [...new Set(loose)].sort(), error: albums.length ? null : 'noAlbumsFound' };
}
