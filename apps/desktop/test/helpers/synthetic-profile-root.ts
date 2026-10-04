import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { SyntheticProfileRoot } from '../../src/main/synthetic-profile-root.js'

/** 仅受控测试显式传给reader；正式wrapper不引用此helper。 */
export function syntheticFixtureRoot(): SyntheticProfileRoot {
  const supplied = process.env.TMPDIR
  if (!supplied || !path.isAbsolute(supplied)) throw new Error('受控测试必须提供批准的TMPDIR。')
  const directory = path.resolve(supplied), info = lstatSync(directory, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory || (info.mode & 0o077n) !== 0n) throw new Error('受控测试根目录身份或权限无效。')
  return { directory, device: String(info.dev) }
}
