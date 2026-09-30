import { constants, accessSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** 本机只使用已挂载的外置卷；GitHub hosted runner 使用自己的真实临时目录。 */
export function e2eTemporaryRoot(): string {
  const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
  const expected = hosted ? process.env.RUNNER_TEMP : '/Volumes/LifeWeave/Developer/CommandLine/tmp'
  if (!expected || !process.env.TMPDIR) throw new Error('E2E 必须明确提供可写的测试临时目录')
  if (!hosted) {
    const mounts = execFileSync('/sbin/mount', { encoding: 'utf8' })
    if (!mounts.split('\n').some(line => line.includes(' on /Volumes/LifeWeave ('))) throw new Error('LifeWeave 外置卷未挂载，停止 E2E')
  }
  const root = realpathSync(expected), actual = realpathSync(process.env.TMPDIR)
  const relative = path.relative(root, actual)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('E2E TMPDIR 必须位于批准的临时根目录中')
  accessSync(actual, constants.R_OK | constants.W_OK)
  return actual
}
