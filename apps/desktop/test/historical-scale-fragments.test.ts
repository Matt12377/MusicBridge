import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeHistoricalFragment, historicalScaleFragment } from './helpers/historical-scale-fragments.js'
for (const name of ['source05-multi-read-fragment.json', 'source05-reset-1-fragment.json', 'source05-reset-2-fragment.json', 'source08-settings-discard-fragment.json'] as const) {
  test('冻结历史片段独立拒绝改字节：' + name, () => {
    assert.ok(historicalScaleFragment(name).events.length > 0)
    const bytes = readFileSync(new URL('./fixtures/rust015-historical/' + name, import.meta.url))
    assert.throws(() => decodeHistoricalFragment(name, Buffer.concat([bytes, Buffer.from(' ')])), /字节身份改变/u)
  })
}
