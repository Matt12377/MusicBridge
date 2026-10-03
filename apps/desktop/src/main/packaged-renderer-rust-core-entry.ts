import { startPackagedRustCoreHost } from './packaged-rust-core-bootstrap.js'
import { installPackagedRendererCoreObserver } from './packaged-renderer-core-observer.js'

declare const __MUSIC_BRIDGE_RUST_MANIFEST_SHA256__: string

// pin 仅为编译字面量，不读取运行时入口、路径或选择器。
const hooks = installPackagedRendererCoreObserver('rust')
void startPackagedRustCoreHost(__MUSIC_BRIDGE_RUST_MANIFEST_SHA256__, hooks).catch(() => { process.exit(1) })
