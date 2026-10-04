import { lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import path from 'node:path'

export interface SyntheticProfileRoot { directory: string; device: string }
const external = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
/** 正式入口固定外置根，不从TMPDIR或CI环境扩大准入。 */
export function externalSyntheticProfileRoot(): SyntheticProfileRoot {
  const mounted = lstatSync('/Volumes/LifeWeave', { bigint: true })
  if (!mounted.isDirectory() || mounted.isSymbolicLink() || realpathSync('/Volumes/LifeWeave') !== '/Volumes/LifeWeave' || mounted.dev === lstatSync('/', { bigint: true }).dev) throw new Error('LifeWeave外置卷未真实挂载。')
  return { directory: external, device: String(mounted.dev) }
}
/** 根的选择由可信调用者完成；此低层函数只核路径/设备/权限，绝不选择环境。 */
export function validateSyntheticProfileDirectory(directory: string | undefined, root: SyntheticProfileRoot): BigIntStats {
  if (!path.isAbsolute(root.directory) || path.resolve(root.directory) !== root.directory || realpathSync(root.directory) !== root.directory) throw new Error('合成测试根真实身份无效。')
  const rootInfo = lstatSync(root.directory, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || String(rootInfo.dev) !== root.device) throw new Error('合成测试根设备身份无效。')
  if (!directory || !directory.startsWith(root.directory + '/') || path.resolve(directory) !== directory || !/^musicbridge-ui-diagnostics-[A-Za-z0-9._-]+$/u.test(path.basename(directory))) throw new Error('合成工作库路径未准入。')
  const identity = lstatSync(directory, { bigint: true })
  if (!identity.isDirectory() || identity.isSymbolicLink() || String(identity.dev) !== root.device || (identity.mode & 0o077n) !== 0n || realpathSync(directory) !== directory) throw new Error('合成工作库真实身份无效。')
  return identity
}
