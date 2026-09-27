import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { utilityProcess } from 'electron'

/** 只供 E2E 启动。正式 Main bundle 不导入此文件，也没有私有 Core 选择开关。 */
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'index.js')
const standardCore = path.join(desktopRoot, 'dist', 'main', 'core.js')
const privateCore = path.join(desktopRoot, '.tmp-test', 'private-core', 'plan-core.js')
if (!existsSync(mainEntry) || !existsSync(privateCore)) throw new Error('隔离 Electron 测试产物尚未构建')
const originalFork = utilityProcess.fork.bind(utilityProcess)
utilityProcess.fork = (entryPath, args, options) => originalFork(entryPath === standardCore ? privateCore : entryPath, args, options)
await import(pathToFileURL(mainEntry).href)
