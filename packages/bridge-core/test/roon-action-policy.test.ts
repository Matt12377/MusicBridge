import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeRoonAction,
  RoonActionBlockedError,
} from '../src/roon/action-policy.js';

test('删除类 Roon Browse Action 永远被阻断', () => {
  for (const title of [
    'Delete',
    'Remove from Library',
    'Delete from Library',
    'Trash',
    'Move to Trash',
    '从音乐库中删除',
    '移到废纸篓',
  ]) {
    assert.throws(
      () => authorizeRoonAction(
        { title, hint: 'action', item_key: `danger:${title}` },
        { kind: 'browse' },
      ),
      (error: unknown) =>
        error instanceof RoonActionBlockedError && error.reason === 'destructive',
    );
  }
});

test('未知 Action 默认阻断，不因 mutation 许可而放行', () => {
  assert.throws(
    () => authorizeRoonAction(
      { title: 'Open Private Custom Action', hint: 'action', item_key: 'unknown:1' },
      { kind: 'favorite', allowMutation: true },
    ),
    (error: unknown) =>
      error instanceof RoonActionBlockedError && error.reason === 'unknown',
  );
});

test('只读 Browse 导航只接受明确的 list 或 action_list hint', () => {
  assert.deepEqual(
    authorizeRoonAction(
      { title: 'Albums', hint: 'list', item_key: 'albums:1' },
      { kind: 'browse' },
    ),
    { kind: 'browse', itemKey: 'albums:1' },
  );
  assert.deepEqual(
    authorizeRoonAction(
      { title: 'Actions', hint: 'action_list', item_key: 'actions:1' },
      { kind: 'browse' },
    ),
    { kind: 'browse', itemKey: 'actions:1' },
  );

  for (const hint of [undefined, null, 'action', 'header', 'future']) {
    assert.throws(
      () => authorizeRoonAction(
        { title: 'Albums', hint, item_key: 'albums:unknown' },
        { kind: 'browse' },
      ),
      RoonActionBlockedError,
    );
  }
});

test('Play、Queue、Favorite 只能通过 typed allowlist 且显式 mutation 许可放行', () => {
  const cases = [
    { title: 'Play Now', kind: 'play' as const, itemKey: 'play:1' },
    { title: 'Add to Queue', kind: 'queue' as const, itemKey: 'queue:1' },
    { title: 'Add to Favorites', kind: 'favorite' as const, itemKey: 'favorite:1' },
  ];

  for (const action of cases) {
    assert.throws(
      () => authorizeRoonAction(
        { title: action.title, hint: 'action', item_key: action.itemKey },
        { kind: action.kind },
      ),
      (error: unknown) =>
        error instanceof RoonActionBlockedError && error.reason === 'permit_required',
    );
    assert.deepEqual(
      authorizeRoonAction(
        { title: action.title, hint: 'action', item_key: action.itemKey },
        { kind: action.kind, allowMutation: true },
      ),
      { kind: action.kind, itemKey: action.itemKey },
    );
  }
});

test('Action 缺失 item_key 时阻断，即使标题在 allowlist 中', () => {
  assert.throws(
    () => authorizeRoonAction(
      { title: 'Play Now', hint: 'action' },
      { kind: 'play', allowMutation: true },
    ),
    (error: unknown) =>
      error instanceof RoonActionBlockedError && error.reason === 'missing_item_key',
  );
});
