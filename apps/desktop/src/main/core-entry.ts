import { runDesktopCoreHost } from './core-host.js'
import { createOptionalRustReadonlyManager } from '../../../../packages/bridge-core/src/rust-core/optional-readonly-manager.js'
import { createPackagedRustReadonlyFactory } from './packaged-rust-core-bootstrap.js'
import { installCollectionReadonlyCoreObserver } from './collection-readonly-core-observer.js'

declare const __MUSIC_BRIDGE_RUST_MANIFEST_SHA256__: string | null
declare const __MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__: boolean

// 默认 OFF 不调用工厂，pin 为编译字面量，能力绝不从运行时输入选择。
let manager: ReturnType<typeof createOptionalRustReadonlyManager>
const hooks = __MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__ === true
  ? installCollectionReadonlyCoreObserver({ getStatus: () => manager.getStatus() }) : undefined
manager = createOptionalRustReadonlyManager({ createOptions: async () => {
  if (__MUSIC_BRIDGE_RUST_MANIFEST_SHA256__ === null) throw new Error('Rust 收藏查询资源不可用。')
  return createPackagedRustReadonlyFactory(__MUSIC_BRIDGE_RUST_MANIFEST_SHA256__, hooks)()
} })
void runDesktopCoreHost({ optionalReadonlyManager: manager, ...(hooks ? { dependencies: hooks.dependencies } : {}) })
