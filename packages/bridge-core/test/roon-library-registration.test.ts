import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductionRoonSdk } from '../src/roon/sdk.js';

test('生产 Roon SDK 注册官方 Browse 与 Image service 构造器', () => {
  const sdk = createProductionRoonSdk();

  assert.equal(typeof sdk.browseService, 'function');
  assert.equal(typeof sdk.imageService, 'function');
});
