import { installPackagedRouteCoreObserver } from './packaged-route-core-observer.js'
import { startPackagedRustCoreHost } from './packaged-rust-core-bootstrap.js'

declare const __MUSIC_BRIDGE_RUST_MANIFEST_SHA256__: string

// 候选独立编译入口：pin 固化为源码常量，原 Main 继续监督包内固定 core.js。
const hooks = installPackagedRouteCoreObserver('rust')
void startPackagedRustCoreHost(__MUSIC_BRIDGE_RUST_MANIFEST_SHA256__, hooks).catch(() => { process.exit(1) })
