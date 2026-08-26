export type RoonActionKind = 'browse' | 'play' | 'queue' | 'favorite';

export interface RoonBrowseItem {
  title?: unknown;
  hint?: unknown;
  item_key?: unknown;
}

export type RoonActionBlockReason =
  | 'destructive'
  | 'unknown'
  | 'missing_item_key'
  | 'permit_required';

export interface RoonActionAuthorization {
  kind: RoonActionKind;
  itemKey: string;
}

export class RoonActionBlockedError extends Error {
  readonly code = 'ROON_ACTION_BLOCKED';

  constructor(readonly reason: RoonActionBlockReason) {
    super(`Roon action blocked: ${reason}`);
    this.name = 'RoonActionBlockedError';
  }
}

const FAVORITE_TITLES = new Set([
  'add to favorite',
  'add to favorites',
  'add to favourite',
  'add to favourites',
  'favorite',
  'favourite',
  'make favorite',
  'make favourite',
  'remove from favorite',
  'remove from favorites',
  'remove from favourite',
  'remove from favourites',
  'unfavorite',
  'unfavourite',
  '加入收藏',
  '加入我的收藏',
  '取消收藏',
  '收藏',
]);

const PLAY_TITLES = new Set([
  'play',
  'play now',
  '立即播放',
  '播放',
]);

const QUEUE_TITLES = new Set([
  'add next',
  'add to queue',
  'play next',
  'queue',
  '下一首播放',
  '加入队列',
]);

const DESTRUCTIVE_PATTERNS = [
  /^(?:delete|trash|move to trash)$/u,
  /^(?:delete|remove) (?:album|artist|track)(?: from (?:the )?(?:library|roon library))?$/u,
  /^(?:delete|remove) from (?:the )?(?:library|roon library)$/u,
  /^(?:delete|remove) (?:from|out of) (?:the )?(?:library|roon library)$/u,
  /^(?:从(?:音乐库|资料库)中?删除|从(?:音乐库|资料库)移除|移到废纸篓|移至废纸篓|删除)$/u,
];

function normalizeTitle(value: unknown): string {
  return typeof value === 'string'
    ? value
      .normalize('NFKC')
      .trim()
      .toLocaleLowerCase('en-US')
      .replace(/[\s\u00a0]+/gu, ' ')
    : '';
}

function isDestructiveTitle(title: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(title));
}

function actionKindForTitle(title: string): Exclude<RoonActionKind, 'browse'> | 'unknown' {
  if (PLAY_TITLES.has(title)) return 'play';
  if (QUEUE_TITLES.has(title)) return 'queue';
  if (FAVORITE_TITLES.has(title)) return 'favorite';
  return 'unknown';
}

function readItemKey(item: RoonBrowseItem): string {
  if (typeof item.item_key !== 'string' || item.item_key.length === 0) {
    throw new RoonActionBlockedError('missing_item_key');
  }
  return item.item_key;
}

export function authorizeRoonAction(
  item: RoonBrowseItem,
  request: { kind: RoonActionKind; allowMutation?: boolean },
): RoonActionAuthorization {
  const title = normalizeTitle(item.title);
  if (isDestructiveTitle(title)) {
    throw new RoonActionBlockedError('destructive');
  }

  const itemKey = readItemKey(item);
  if (request.kind === 'browse') {
    if (item.hint !== 'list' && item.hint !== 'action_list') {
      throw new RoonActionBlockedError('unknown');
    }
    return { kind: 'browse', itemKey };
  }

  if (item.hint !== 'action') {
    throw new RoonActionBlockedError('unknown');
  }

  const observedKind = actionKindForTitle(title);
  if (observedKind === 'unknown' || observedKind !== request.kind) {
    throw new RoonActionBlockedError('unknown');
  }
  if (request.allowMutation !== true) {
    throw new RoonActionBlockedError('permit_required');
  }
  return { kind: request.kind, itemKey };
}
