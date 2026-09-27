import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bundlePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(desktopRoot, 'dist/preload/index.cjs')
const source = readFileSync(bundlePath, 'utf8')
const calls = [...source.matchAll(/\brequire\s*\(/gu)]
const staticModules = [...source.matchAll(/\brequire\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/gu)].map(match => match[2])
const unique = [...new Set(staticModules)]

if (calls.length !== staticModules.length || unique.length !== 1 || unique[0] !== 'electron') {
  process.stderr.write(`沙盒 Preload 依赖门禁失败：仅允许静态 require('electron')；实际 ${JSON.stringify(unique)}，调用 ${calls.length}，静态解析 ${staticModules.length}。\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`沙盒 Preload 依赖门禁通过：${bundlePath} 仅 require('electron')，共 ${calls.length} 处。\n`)
}
