import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'

test('录音页深色变量只落在录音页容器，而非全局根节点', () => {
  const filename = new URL('../src/renderer/src/components/recording/RecordingView.vue', import.meta.url)
  const source = readFileSync(filename, 'utf8')
  const { descriptor, errors } = parse(source, { filename: filename.pathname })
  assert.equal(errors.length, 0)
  const style = descriptor.styles.find(item => item.scoped)
  assert.ok(style)
  const compiled = compileStyle({ filename: filename.pathname, id: 'data-v-recording-dark-test', source: style.content, scoped: true })
  assert.equal(compiled.errors.length, 0)

  const darkRule = compiled.code.match(/:root\[data-theme=['"]dark['"]\][^{]*\{[^}]*--recording-card-bg:[^}]*\}/u)?.[0]
  assert.ok(darkRule, '编译后的 CSS 应保留深色卡片变量')
  assert.match(darkRule, /\.recording-view(?:\[data-v-recording-dark-test\])?/u, '深色变量必须限定录音页')
  assert.doesNotMatch(compiled.code, /:root\[data-theme=['"]dark['"]\]\s*\{[^}]*--recording-card-bg/u, '不得污染全局主题根节点')
})
