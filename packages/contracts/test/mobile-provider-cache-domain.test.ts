import assert from 'node:assert/strict';
import test from 'node:test';
import { isMobileUIContentCapabilities } from '../src/mobile-content.js';

const old = { version: '1.0.0', addedAlbums: 'ready', neteaseDailyRecommendations: 'ready', lyrics: 'ready' };

test('Provider展示缓存账号域是兼容的可选字段，缺省保留原能力合同', () => {
  assert.equal(isMobileUIContentCapabilities(old), true);
  assert.equal(isMobileUIContentCapabilities({ ...old, neteaseAccountDomain: 'ne:account.fixture' }), true);
  for (const value of [null, '', 'contains space', 'a'.repeat(161), 1, {}, []]) {
    assert.equal(isMobileUIContentCapabilities({ ...old, neteaseAccountDomain: value }), false);
  }
});
