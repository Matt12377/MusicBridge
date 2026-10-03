import { runDesktopCoreHost } from './core-host.js'
import { installPackagedRendererCoreObserver } from './packaged-renderer-core-observer.js'

// 静态候选入口；原 Main 仍监督包内固定 core.js。
const hooks = installPackagedRendererCoreObserver('node')
void runDesktopCoreHost({ dependencies: hooks.dependencies }).catch(() => { process.exit(1) })
