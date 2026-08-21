import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const MAX_CONFIG_BYTES = 2 * 1024 * 1024

export type RoonConfigMigrationStatus =
  | 'missing'
  | 'invalid'
  | 'already_present'
  | 'copied'

export interface RoonConfigMigrationResult {
  status: RoonConfigMigrationStatus
}

interface ConfigFile {
  contents: string
}

async function readValidatedConfig(filePath: string): Promise<ConfigFile | undefined> {
  let stats
  try {
    stats = await lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) throw new Error('invalid config file')
  const contents = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(contents) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid config JSON')
  }
  return { contents }
}

export async function migrateRoonConfig(options: {
  legacyPath: string
  targetPath: string
}): Promise<RoonConfigMigrationResult> {
  let legacy: ConfigFile | undefined
  try {
    legacy = await readValidatedConfig(options.legacyPath)
  } catch {
    return { status: 'invalid' }
  }
  if (!legacy) return { status: 'missing' }

  let target: ConfigFile | undefined
  try {
    target = await readValidatedConfig(options.targetPath)
  } catch {
    return { status: 'invalid' }
  }
  if (target) {
    await chmod(options.targetPath, 0o600)
    return { status: 'already_present' }
  }

  await mkdir(path.dirname(options.targetPath), { recursive: true })
  const temporaryPath = `${options.targetPath}.tmp-${randomUUID()}`
  try {
    await writeFile(temporaryPath, legacy.contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, options.targetPath)
    const copied = await readValidatedConfig(options.targetPath)
    if (!copied) throw new Error('target disappeared after migration')
    await chmod(options.targetPath, 0o600)
    return { status: 'copied' }
  } catch {
    await unlink(temporaryPath).catch(() => undefined)
    return { status: 'invalid' }
  }
}
