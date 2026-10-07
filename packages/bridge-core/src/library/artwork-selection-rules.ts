/** 内部身份和排序规则；dataset 分区、持久化、请求代际及选择 CAS 由原 owner 服务负责。 */
export type ArtworkPurposeScope =
  | { purpose: 'digital'; editionId: string; editionRevision: string }
  | { purpose: 'tape-reference'; bookId: string; referenceId: string; sourceVersionId: string; catalogRevisionId: string }
  | { purpose: 'personal-photo'; modelId: string; modelRevision: number; physicalId: string | null }
  | { purpose: 'frozen-master'; masterVersionId: string; artworkVersionId: string; artworkSequence: number };

export interface ArtworkRuleCandidate {
  id: string;
  origin: 'local-independent' | 'embedded' | 'manual' | 'provider';
  sourceIdentity: string;
}
export const MAX_ARTWORK_RULE_CANDIDATES = 32;

function ruleError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
/** 先检查所有描述符，再读取判别字段；不执行 getter。 */
function dataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor !== undefined && descriptor.enumerable
      && Object.hasOwn(descriptor, 'value');
  });
}
function closed(value: Record<string, unknown>, names: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === names.length && names.every(key => Object.hasOwn(value, key))
    && keys.every(key => typeof key === 'string' && names.includes(key));
}
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const referenceKey = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(value);
const physicalId = (value: unknown): value is string | null => value === null
  || typeof value === 'string' && /^MB-[CD]-\d{5,9}$/u.test(value);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= min && value <= max;
const uint64 = 18_446_744_073_709_551_615n;
const revision = (value: unknown): value is string => typeof value === 'string' && value.length <= 20
  && /^[1-9][0-9]*$/u.test(value) && BigInt(value) <= uint64;

export function isArtworkPurposeScope(value: unknown): value is ArtworkPurposeScope {
  try {
    if (!dataRecord(value) || !Object.hasOwn(value, 'purpose')) return false;
    switch (value.purpose) {
      case 'digital':
        return closed(value, ['purpose', 'editionId', 'editionRevision']) && uuid(value.editionId) && revision(value.editionRevision);
      case 'tape-reference':
        return closed(value, ['purpose', 'bookId', 'referenceId', 'sourceVersionId', 'catalogRevisionId'])
          && referenceKey(value.bookId) && referenceKey(value.referenceId) && uuid(value.sourceVersionId) && uuid(value.catalogRevisionId);
      case 'personal-photo':
        return closed(value, ['purpose', 'modelId', 'modelRevision', 'physicalId']) && uuid(value.modelId)
          && integer(value.modelRevision, 1, Number.MAX_SAFE_INTEGER) && physicalId(value.physicalId);
      case 'frozen-master':
        return closed(value, ['purpose', 'masterVersionId', 'artworkVersionId', 'artworkSequence'])
          && uuid(value.masterVersionId) && uuid(value.artworkVersionId) && integer(value.artworkSequence, 1, 100);
      default: return false;
    }
  } catch { return false; }
}
function checkedScope(scope: ArtworkPurposeScope): void {
  if (!isArtworkPurposeScope(scope)) throw ruleError('ARTWORK_INVALID_SCOPE', '封面用途、目标身份或修订无效');
}

/** 稳定关系键不包含标题/型号修订；同一目标的手选关系不随无关修订丢失。 */
export function stableArtworkTargetKey(scope: ArtworkPurposeScope): string {
  checkedScope(scope);
  switch (scope.purpose) {
    case 'digital': return JSON.stringify(['digital', scope.editionId]);
    case 'tape-reference': return JSON.stringify(['tape-reference', scope.bookId, scope.referenceId]);
    case 'personal-photo': return JSON.stringify(['personal-photo', scope.modelId, scope.physicalId]);
    case 'frozen-master': return JSON.stringify(['frozen-master', scope.masterVersionId, scope.artworkVersionId]);
  }
}
/** 请求围栏包含全部目标/版本修订；它不充当持久选择主键。 */
export function artworkRequestFence(scope: ArtworkPurposeScope): string {
  checkedScope(scope);
  switch (scope.purpose) {
    case 'digital': return JSON.stringify(['digital', scope.editionId, scope.editionRevision]);
    case 'tape-reference': return JSON.stringify(['tape-reference', scope.bookId, scope.referenceId, scope.sourceVersionId, scope.catalogRevisionId]);
    case 'personal-photo': return JSON.stringify(['personal-photo', scope.modelId, scope.physicalId, scope.modelRevision]);
    case 'frozen-master': return JSON.stringify(['frozen-master', scope.masterVersionId, scope.artworkVersionId, scope.artworkSequence]);
  }
}
/** 冻结对象只供读取；选图服务不得将它委托到普通 mutation。 */
export function assertArtworkMutationAllowed(scope: ArtworkPurposeScope): void {
  checkedScope(scope);
  if (scope.purpose === 'frozen-master') throw ruleError('ARTWORK_FROZEN_IMMUTABLE', '冻结 MasterArtwork 不允许普通选图修改');
}

const identityText = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 512
  && value === value.trim() && !/[\u0000-\u001f\u007f]|[a-z][a-z0-9+.-]*:\/\/|(?:bearer|cookie|token|session)\s*[:=]/iu.test(value);
const origins: Readonly<Record<ArtworkRuleCandidate['origin'], number>> = {
  'local-independent': 0, embedded: 1, manual: 2, provider: 3,
};
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
function candidateArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= MAX_ARTWORK_RULE_CANDIDATES
    && Reflect.ownKeys(value).length === value.length + 1 && Reflect.ownKeys(value).every(key => {
      if (key === 'length') return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === 'string' && /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length
        && descriptor !== undefined && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
    });
}

/**
 * 候选可保留服务已验证的额外元数据；本层检查所有顶层 data 属性及三个排序字段。
 * 仅用来源顺序/来源身份/候选身份排序，既不读图像 Hash，也不合并音乐版本或判断音质。
 */
export function rankArtworkCandidates<T extends ArtworkRuleCandidate>(candidates: readonly T[]): T[] {
  if (!candidateArray(candidates)) throw ruleError('ARTWORK_INVALID_CANDIDATES', '封面候选必须为有界、无隐藏字段的连续数组');
  const ranked = candidates.map(candidate => {
    if (!dataRecord(candidate) || !['id', 'origin', 'sourceIdentity'].every(key => Object.hasOwn(candidate, key))
      || !identityText(candidate.id) || !identityText(candidate.sourceIdentity)
      || typeof candidate.origin !== 'string' || !Object.hasOwn(origins, candidate.origin)) {
      throw ruleError('ARTWORK_INVALID_CANDIDATES', '封面候选身份、来源或数据字段无效');
    }
    return { candidate, id: candidate.id, sourceIdentity: candidate.sourceIdentity,
      priority: origins[candidate.origin as ArtworkRuleCandidate['origin']] };
  });
  if (new Set(ranked.map(item => item.id)).size !== ranked.length) throw ruleError('ARTWORK_CANDIDATE_ID_CONFLICT', '封面候选身份重复，不能静默覆盖');
  ranked.sort((left, right) => left.priority - right.priority || compareText(left.sourceIdentity, right.sourceIdentity) || compareText(left.id, right.id));
  return ranked.map(item => item.candidate);
}
/** 缺封面返回 null；manual/provider 都必须由用户明确应用，不能冒充自动本地图。 */
export function defaultArtworkCandidate<T extends ArtworkRuleCandidate>(candidates: readonly T[]): T | null {
  return rankArtworkCandidates(candidates).find(candidate => candidate.origin === 'local-independent' || candidate.origin === 'embedded') ?? null;
}
