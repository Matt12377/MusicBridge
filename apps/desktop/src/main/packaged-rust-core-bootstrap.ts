import { runDesktopCoreHost, type DesktopCoreHostOptions } from './core-host.js'
import { resolveRustCoreResource, type RustCoreResource } from './rust-core-resource.js'
import type { RustReadonlyCoreOptions } from '../../../../packages/bridge-core/src/rust-core/core-dataset-owner.js'

/** 候选包内可信源码持有的能力；不从环境、参数或父端口选择资源。 */
export interface PackagedRustCoreHooks {
  env?: NodeJS.ProcessEnv
  dependencies?: DesktopCoreHostOptions['dependencies']
  onRustReadonlyCoreController?: DesktopCoreHostOptions['onRustReadonlyCoreController']
  onObservation?: RustReadonlyCoreOptions['onObservation']
  onResourceValidated?: (resource: RustCoreResource) => void
}

export function createPackagedRustReadonlyFactory(expectedManifestSha256: string, hooks: PackagedRustCoreHooks = {}) {
  const onObservation = hooks.onObservation
  const onResourceValidated = hooks.onResourceValidated
  return async (): Promise<RustReadonlyCoreOptions> => {
    const resource = await resolveRustCoreResource({ resourcesDirectory: process.resourcesPath, expectedManifestSha256 })
    if (onResourceValidated !== undefined) {
      const returned: unknown = onResourceValidated(resource)
      if (returned !== undefined) {
        void Promise.resolve(returned).catch(() => {})
        throw new Error('可信 Rust 资源观察者必须同步返回空值。')
      }
    }
    // 已冻结清单协议 v2；候选不由输入扩大到 large v3。
    return Object.freeze({ binary: resource.binary, snapshotProfile: 'v2-2000',
      ...(onObservation === undefined ? {} : { onObservation }) })
  }
}

/** 先同步注册 utility 原父端口监听，收到合规启动端口后才异步准入资源。 */
export function startPackagedRustCoreHost(expectedManifestSha256: string, hooks: PackagedRustCoreHooks = {}): Promise<void> {
  return runDesktopCoreHost({ env: hooks.env, dependencies: hooks.dependencies,
    onRustReadonlyCoreController: hooks.onRustReadonlyCoreController,
    createRustReadonlyCollection: createPackagedRustReadonlyFactory(expectedManifestSha256, hooks) })
}
