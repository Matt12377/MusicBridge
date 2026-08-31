import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const jointIssuer = new URL('../issue-v3-capacity-joint-generation-window.py', import.meta.url)
const objectsRecoveryIssuer = new URL('../issue-v3-capacity-window.py', import.meta.url)

test('joint generation必须使用专用issuer，不能放宽objects-limit失败恢复入口', () => {
  assert.equal(existsSync(jointIssuer), true, '缺少专用joint generation issuer')
  const jointSource = readFileSync(jointIssuer, 'utf8')
  const recoverySource = readFileSync(objectsRecoveryIssuer, 'utf8')
  assert.match(jointSource, /objects-limit:queued-stop:PASS/u)
  assert.match(jointSource, /2_701_131_776/u)
  assert.match(jointSource, /'profile': 'joint'/u)
  assert.match(recoverySource, /choices=\('objects-limit',\)/u)
  assert.doesNotMatch(recoverySource, /choices=\('objects-limit', 'joint'\)/u)
})
