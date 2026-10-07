import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ARTWORK_RULE_CANDIDATES, assertArtworkMutationAllowed, artworkRequestFence, defaultArtworkCandidate,
  isArtworkPurposeScope, rankArtworkCandidates, stableArtworkTargetKey,
  type ArtworkPurposeScope, type ArtworkRuleCandidate,
} from '../src/library/artwork-selection-rules.js';

const id = (n: number): string => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const digital = (n = 1, editionRevision = '1'): Extract<ArtworkPurposeScope, { purpose: 'digital' }> =>
  ({ purpose: 'digital', editionId: id(n), editionRevision });
const tape = (): Extract<ArtworkPurposeScope, { purpose: 'tape-reference' }> =>
  ({ purpose: 'tape-reference', bookId: 'synthetic-book', referenceId: 'synthetic-reference', sourceVersionId: id(2), catalogRevisionId: id(3) });
const photo = (): Extract<ArtworkPurposeScope, { purpose: 'personal-photo' }> =>
  ({ purpose: 'personal-photo', modelId: id(4), modelRevision: 1, physicalId: 'MB-C-00001' });
const frozen = (): Extract<ArtworkPurposeScope, { purpose: 'frozen-master' }> =>
  ({ purpose: 'frozen-master', masterVersionId: id(5), artworkVersionId: id(6), artworkSequence: 1 });
const candidate = (id: string, origin: ArtworkRuleCandidate['origin'], sourceIdentity = id): ArtworkRuleCandidate => ({ id, origin, sourceIdentity });
const hasCode = (code: string) => (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === code;

test('四用途按现有实体身份和修订类型识别', () => {
  for (const scope of [digital(), tape(), photo(), frozen()]) assert.equal(isArtworkPurposeScope(scope), true);
  assert.equal(isArtworkPurposeScope({ ...photo(), physicalId: null }), true);
  assert.equal(isArtworkPurposeScope(Object.assign(Object.create(null), digital())), true);
  for (const input of [null, [], { ...digital(), editionRevision: 1 }, { ...digital(), editionRevision: '0' },
    { ...digital(), editionRevision: '18446744073709551616' }, { ...photo(), modelRevision: '1' },
    { ...photo(), modelRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...photo(), physicalId: '/synthetic' },
    { ...frozen(), artworkSequence: 101 }, { ...tape(), sourceVersionId: 'https://example.invalid' }]) {
    assert.equal(isArtworkPurposeScope(input), false);
  }
});

test('scope 的判别字段和身份 getter 均不执行', () => {
  let calls = 0;
  for (const field of ['purpose', 'editionId', 'editionRevision']) {
    const input = { ...digital() };
    Object.defineProperty(input, field, { enumerable: true, get() { calls++; return field === 'purpose' ? 'digital' : '1'; } });
    assert.equal(isArtworkPurposeScope(input), false);
  }
  assert.equal(calls, 0);
});

test('scope 拒绝隐藏、Symbol、额外字段和继承属性', () => {
  const hidden = { ...digital() }; Object.defineProperty(hidden, 'sha256', { value: 'a'.repeat(64) });
  const symbol = { ...digital(), [Symbol('synthetic')]: true };
  for (const input of [hidden, symbol, { ...digital(), albumTitle: '同名专辑' },
    { ...digital(), audioQualityVerified: true }, Object.assign(Object.create({ purpose: 'digital' }), digital())]) {
    assert.equal(isArtworkPurposeScope(input), false);
  }
  const inherited = Object.create({ purpose: 'digital', editionId: id(1), editionRevision: '1' });
  assert.equal(isArtworkPurposeScope(inherited), false);
});

test('数字标题修订只更新请求围栏，稳定关系仍查回原手选', () => {
  const before = digital(1, '1'), after = digital(1, '2');
  const selection = { mode: 'manual', candidateId: id(100), selectionRevision: '3' };
  const saved = new Map([[stableArtworkTargetKey(before), selection]]);
  assert.notEqual(artworkRequestFence(before), artworkRequestFence(after));
  assert.equal(stableArtworkTargetKey(before), stableArtworkTargetKey(after));
  assert.equal(saved.get(stableArtworkTargetKey(after)), selection);
  assert.equal(saved.get(stableArtworkTargetKey(after))?.mode, 'manual');
  assert.equal(saved.get(stableArtworkTargetKey(after))?.candidateId, id(100));
});

test('参考来源/目录修订和个人型号修订不抹去稳定手选关系', () => {
  const reference = tape(), personal = photo();
  const changedReference = { ...reference, sourceVersionId: id(20), catalogRevisionId: id(21) };
  const changedPersonal = { ...personal, modelRevision: 2 };
  for (const [before, after] of [[reference, changedReference], [personal, changedPersonal]] as const) {
    const saved = { mode: 'manual', candidateId: id(101) }, map = new Map([[stableArtworkTargetKey(before), saved]]);
    assert.equal(map.get(stableArtworkTargetKey(after)), saved);
    assert.notEqual(artworkRequestFence(before), artworkRequestFence(after));
  }
});

test('所有身份/版本变化均进入请求围栏，版本字段不成为稳定主键', () => {
  const reference = tape(), personal = photo(), master = frozen();
  for (const changed of [{ ...reference, sourceVersionId: id(10) }, { ...reference, catalogRevisionId: id(11) }]) {
    assert.notEqual(artworkRequestFence(reference), artworkRequestFence(changed));
    assert.equal(stableArtworkTargetKey(reference), stableArtworkTargetKey(changed));
  }
  assert.notEqual(artworkRequestFence(personal), artworkRequestFence({ ...personal, modelRevision: 2 }));
  assert.notEqual(artworkRequestFence(master), artworkRequestFence({ ...master, artworkSequence: 2 }));
  assert.equal(stableArtworkTargetKey(master), stableArtworkTargetKey({ ...master, artworkSequence: 2 }));
});

test('同名专辑、不同个人实物、不同冻结版本与四用途选择键彼此独立', () => {
  const keys = [digital(1), digital(2), tape(), photo(), { ...photo(), physicalId: 'MB-C-00002' },
    frozen(), { ...frozen(), artworkVersionId: id(7) }].map(stableArtworkTargetKey);
  assert.equal(new Set(keys).size, keys.length);
  const sameBytes = 'a'.repeat(64);
  const relationships = [digital(), tape(), photo(), frozen()].map(scope => ({ targetKey: stableArtworkTargetKey(scope), sha256: sameBytes }));
  assert.equal(new Set(relationships.map(item => item.targetKey)).size, 4);
  assert.equal(new Set(relationships.map(item => item.sha256)).size, 1);
});

test('Frozen mutation 明确拒绝，其余用途只通过规则许可且不实际写入', () => {
  assert.throws(() => assertArtworkMutationAllowed(frozen()), hasCode('ARTWORK_FROZEN_IMMUTABLE'));
  for (const scope of [digital(), tape(), photo()]) assert.doesNotThrow(() => assertArtworkMutationAllowed(scope));
  const invalid = { ...digital(), extra: true };
  assert.throws(() => stableArtworkTargetKey(invalid), hasCode('ARTWORK_INVALID_SCOPE'));
  assert.throws(() => artworkRequestFence(invalid), hasCode('ARTWORK_INVALID_SCOPE'));
  assert.throws(() => assertArtworkMutationAllowed(invalid), hasCode('ARTWORK_INVALID_SCOPE'));
});

test('默认独立图优先内嵌图，不依赖输入顺序', () => {
  const independent = candidate('independent', 'local-independent'), embedded = candidate('embedded', 'embedded');
  assert.equal(defaultArtworkCandidate([embedded, independent]), independent);
  assert.equal(defaultArtworkCandidate([independent, embedded]), independent);
  assert.equal(defaultArtworkCandidate([embedded]), embedded);
});

test('缺图和仅 manual/provider 时返回 null，候选仍可比较', () => {
  const manual = candidate('manual', 'manual'), provider = candidate('provider', 'provider');
  assert.equal(defaultArtworkCandidate([]), null);
  assert.equal(defaultArtworkCandidate([manual, provider]), null);
  assert.deepEqual(rankArtworkCandidates([provider, manual]), [manual, provider]);
});

test('人工候选与本地图并存时仍可比较，默认只返回本地图', () => {
  const manual = candidate('manual', 'manual'), automatic = candidate('local', 'local-independent');
  assert.equal(defaultArtworkCandidate([manual, automatic]), automatic);
  assert.deepEqual(rankArtworkCandidates([manual, automatic]), [automatic, manual]);
});

test('相同优先级按来源身份和候选身份确定排序，输入与附加元数据保持完整', () => {
  const a = { ...candidate('b', 'embedded', 'same'), width: 100 }, b = { ...candidate('a', 'embedded', 'same'), width: 200 };
  const c = { ...candidate('z', 'embedded', 'before'), width: 300 };
  const input = Object.freeze([a, c, b]), original = [...input];
  const ranked = rankArtworkCandidates(input);
  assert.deepEqual(ranked.map(item => item.id), ['z', 'a', 'b']);
  assert.equal(ranked[0]?.width, 300);
  assert.notEqual(ranked, input); assert.deepEqual(input, original);
});

test('相同 Hash/来源图片不去重候选，不合并发行或推断音质', () => {
  const hash = 'a'.repeat(64);
  const first = { ...candidate('edition-one', 'embedded', 'same-image'), sha256: hash, editionId: id(1) };
  const second = { ...candidate('edition-two', 'embedded', 'same-image'), sha256: hash, editionId: id(2) };
  const ranked = rankArtworkCandidates([second, first]);
  assert.equal(ranked.length, 2);
  assert.deepEqual(new Set(ranked.map(item => item.editionId)), new Set([id(1), id(2)]));
  assert.ok(ranked.every(item => !Object.hasOwn(item, 'audioQualityVerified')));
});

test('候选所有顶层 getter 在排序拒绝前也不执行', () => {
  let calls = 0;
  for (const field of ['id', 'origin', 'sourceIdentity', 'extra']) {
    const value = candidate('one', 'embedded');
    Object.defineProperty(value, field, { enumerable: true, get() { calls++; return 'embedded'; } });
    assert.throws(() => rankArtworkCandidates([value]), hasCode('ARTWORK_INVALID_CANDIDATES'));
  }
  assert.equal(calls, 0);
  const coercion = { ...candidate('coercion', 'embedded'), origin: { toString() { calls++; return 'embedded'; } } };
  assert.throws(() => rankArtworkCandidates([coercion as unknown as ArtworkRuleCandidate]), hasCode('ARTWORK_INVALID_CANDIDATES'));
  assert.equal(calls, 0);
});

test('候选拒绝 Symbol、隐藏、继承、错误来源和重复候选身份', () => {
  const hidden = candidate('one', 'embedded'); Object.defineProperty(hidden, 'private', { value: true });
  const symbol = { ...candidate('one', 'embedded'), [Symbol('synthetic')]: true };
  const inherited = Object.assign(Object.create({ inherited: true }), candidate('one', 'embedded'));
  for (const input of [hidden, symbol, inherited, { ...candidate('one', 'embedded'), origin: 'synthetic-provider' }]) {
    assert.throws(() => rankArtworkCandidates([input as ArtworkRuleCandidate]), hasCode('ARTWORK_INVALID_CANDIDATES'));
  }
  assert.throws(() => rankArtworkCandidates([candidate('same', 'embedded'), candidate('same', 'manual')]), hasCode('ARTWORK_CANDIDATE_ID_CONFLICT'));
});

test('连续数组与数量围栏拒绝空洞、索引getter和隐藏字段', () => {
  let calls = 0;
  const sparse = new Array<ArtworkRuleCandidate>(1), getter = [candidate('one', 'embedded')];
  Object.defineProperty(getter, '0', { enumerable: true, get() { calls++; return candidate('one', 'embedded'); } });
  const hidden = [candidate('one', 'embedded')]; Object.defineProperty(hidden, 'hidden', { value: true });
  for (const input of [sparse, getter, hidden, Array.from({ length: MAX_ARTWORK_RULE_CANDIDATES + 1 }, (_, n) => candidate(String(n), 'embedded'))]) {
    assert.throws(() => rankArtworkCandidates(input), hasCode('ARTWORK_INVALID_CANDIDATES'));
  }
  assert.equal(calls, 0);
});
