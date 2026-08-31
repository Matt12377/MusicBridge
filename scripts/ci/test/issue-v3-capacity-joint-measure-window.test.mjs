import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const jointMeasureIssuer = new URL('../issue-v3-capacity-joint-measure-window.py', import.meta.url)
const objectsMeasureIssuer = new URL('../issue-v3-capacity-measure-window.py', import.meta.url)

test('joint measure必须使用专用issuer，不能放宽objects-limit历史恢复入口', () => {
  assert.equal(existsSync(jointMeasureIssuer), true, '缺少专用joint measure issuer')
  const jointSource = readFileSync(jointMeasureIssuer, 'utf8')
  const objectsSource = readFileSync(objectsMeasureIssuer, 'utf8')
  assert.match(jointSource, /joint:generate:PASS/u)
  assert.match(jointSource, /'profile': 'joint'/u)
  assert.match(objectsSource, /choices=\('objects-limit',\)/u)
  assert.doesNotMatch(objectsSource, /choices=\('objects-limit', 'joint'\)/u)
})
