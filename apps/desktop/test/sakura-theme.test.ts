import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve('src/renderer/src')

function luminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/gi)!.map(value => {
    const normalized = parseInt(value, 16) / 255
    return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4
  })
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722
}

test('樱花主题文字与强调按钮有独立语义颜色且满足基础对比度', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8')
  const token = (name: string) => {
    const value = css.match(new RegExp(`${name}:\\s*(#[a-f\\d]{6})`, 'i'))?.[1]
    assert.ok(value, `缺少颜色 token：${name}`)
    return value
  }
  const ratio = (a: string, b: string) => {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (values[0]! + .05) / (values[1]! + .05)
  }
  for (const name of ['--mb-text-primary', '--mb-text-secondary', '--mb-text-tertiary']) {
    assert.ok(ratio(token(name), token('--mb-bg-deep')) >= 4.5, `${name} 对比度不足`)
  }
  assert.ok(ratio(token('--mb-on-accent'), token('--mb-accent')) >= 4.5)
  assert.doesNotMatch(css, /(?:^|[;{]\s*)color:\s*rgba\(255,\s*255,\s*255,/m)
})

test('正式入口加载玻璃层，覆盖队列、内容与无透明效果回退', async () => {
  const entry = await readFile(path.join(root, 'main.ts'), 'utf8')
  assert.match(entry, /import '\.\/sakura-theme\.css'/)
  const theme = await readFile(path.join(root, 'sakura-theme.css'), 'utf8')
  for (const selector of ['.album-ambient', '.music-sidebar', '.global-player', '.playback-inspector', '.track-table-wrap', '.settings-glass-panel']) {
    assert.ok(theme.includes(selector), `缺少材质覆盖：${selector}`)
  }
  assert.match(theme, /prefers-reduced-transparency/)
  assert.match(theme, /prefers-reduced-motion/)
  assert.doesNotMatch(theme, /animation:\s*.*(?:infinite|sakura)/)
  assert.match(theme, /:focus-visible/)
})

test('原生窗口底色跟随樱花主题，避免启动时闪黑', async () => {
  const main = await readFile(path.resolve('src/main/index.ts'), 'utf8')
  assert.match(main, /backgroundColor:\s*'#f8eaf1'/)
  assert.ok(main.includes("nativeTheme.themeSource = 'light'"), '原生标题栏必须与浅色内容一致')
})

test('边栏和控件使用透色毛玻璃，而不是统一乳白实色填充', async () => {
  const theme = await readFile(path.join(root, 'sakura-theme.css'), 'utf8')
  assert.ok(theme.includes('var(--mb-frosted-control)'), '控件缺少独立透色毛玻璃材质')
  assert.ok(theme.includes('var(--mb-frosted-plane)'), '边栏缺少透色玻璃材质')
  assert.match(theme, /backdrop-filter:\s*blur\(14px\) saturate\(1\.4\)/)
  assert.match(theme, /inset 0 1px 0 rgba\(255, 255, 255, \.8\)/)
})
