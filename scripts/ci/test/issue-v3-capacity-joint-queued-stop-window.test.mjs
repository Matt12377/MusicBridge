import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const jointIssuer = new URL('../issue-v3-capacity-joint-queued-stop-window.py', import.meta.url)
const objectsIssuer = new URL('../issue-v3-capacity-queued-stop-window.py', import.meta.url)
const supervisor = new URL('../capacity-phase-supervisor-v2.py', import.meta.url)

test('joint queued-stop必须有专用issuer和独立消费合同', () => {
  assert.equal(existsSync(jointIssuer), true, '缺少专用joint queued-stop issuer')
  const jointSource = readFileSync(jointIssuer, 'utf8')
  const objectsSource = readFileSync(objectsIssuer, 'utf8')
  const supervisorSource = readFileSync(supervisor, 'utf8')
  assert.match(jointSource, /joint:measure:PASS/u)
  assert.match(jointSource, /'profile': 'joint'/u)
  assert.match(objectsSource, /choices=\('objects-limit',\)/u)
  assert.doesNotMatch(objectsSource, /choices=\('objects-limit', 'joint'\)/u)
  assert.match(supervisorSource, /'profile': 'objects-limit'/u)
  assert.match(supervisorSource, /--profile', 'objects-limit'/u)
})
